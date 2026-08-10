// Local, on-device speech recognition for the gesture tracker.
//
// Uses macOS's built-in Speech framework with requiresOnDeviceRecognition so
// no audio ever leaves the machine. The Node server (`jarvis_speech`) shells
// out to this binary. Protocol: one UTF-8 line per finalized utterance:
//
//   RESULT:<recognized text>
//
// Fatal problems print as `ERR:<message>` and exit so the server can fall back
// to the browser's own speech recogniser.

import Foundation
import Speech
import AVFoundation

final class JarvisListener {
    private let recognizer: SFSpeechRecognizer?
    private var engine = AVAudioEngine()
    private var activeRequest: SFSpeechAudioBufferRecognitionRequest?

    init() {
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    func installAbortTrap() {
    // macOS's TCC can abort the process (SIGABRT) when a privacy API is
    // requested from a session that can't show the consent prompt. We can't
    // prevent that, but we can turn it into a clean error line so the server
    // falls back instead of leaving a mysterious crash.
    signal(SIGABRT) { _ in
        let msg = "ERR:couldn't request permission in this session — grant Microphone + Speech Recognition, or fall back to browser voice\n"
        _ = msg.withCString {
            write(STDERR_FILENO, $0, Int(strlen($0)))
        }
        exit(1)
    }
}

func run() {
        installAbortTrap()
        // Do everything on a background thread; the main thread stays free so
        // async permission callbacks (often delivered on main) can run.
        DispatchQueue.global().async { [weak self] in self?.startFlow() }
        RunLoop.main.run()
    }

    func startFlow() {
        guard let r = recognizer else { fail("en-US speech recognizer is not available") }
        guard r.isAvailable else { fail("speech recognizer not available") }
        guard r.supportsOnDeviceRecognition else {
            fail("this Mac does not support on-device English recognition")
        }

        // Check TCC (privacy) statuses without triggering a crash. On a normal
        // GUI session these APIs prompt; in a headless shell they can abort the
        // process — the Node server treats a dead child as "local speech
        // unavailable" and falls back to the browser's recogniser.
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .denied || speechStatus == .restricted {
            fail("speech recognition permission is blocked — enable it in System Settings › Privacy & Security")
        }
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        if micStatus == .denied || micStatus == .restricted {
            fail("microphone permission is blocked — enable it in System Settings › Privacy & Security")
        }

        if speechStatus == .notDetermined || micStatus == .notDetermined {
            let sem = DispatchSemaphore(value: 0)
            var speechOk = speechStatus == .authorized
            var micOk = micStatus == .authorized
            if speechStatus == .notDetermined {
                SFSpeechRecognizer.requestAuthorization { s in
                    speechOk = (s == .authorized)
                    sem.signal()
                }
                sem.wait()
            }
            if micStatus == .notDetermined {
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    micOk = granted
                    sem.signal()
                }
                sem.wait()
            }
            guard speechOk else { fail("speech permission denied — allow Speech Recognition for your terminal") }
            guard micOk else { fail("microphone permission denied — allow your terminal to use the microphone") }
        }

        startEngineAndRecognize()
    }

    private func fail(_ message: String) -> Never {
        print("ERR:" + message)
        fflush(stdout)
        exit(1)
    }

    private func startEngineAndRecognize() {
        // Recreate the engine every cycle. If we keep the same engine running
        // across tasks, the mic tap keeps feeding buffered tail-audio into each
        // new request and the same phrase gets recognized repeatedly.
        if engine.isRunning { engine.stop() }
        engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.inputFormat(forBus: 0)
        if format.sampleRate <= 0 || format.channelCount == 0 {
            fail("no microphone found — make sure a mic is enabled")
        }
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.activeRequest?.append(buffer)
        }

        do {
            try engine.start()
        } catch {
            fail("could not start microphone: \(error.localizedDescription)")
        }

        beginNewRecognitionTask()
    }

    private func beginNewRecognitionTask() {
        guard let recognizer = recognizer else { fail("recognizer gone") }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        // Bias the on-device model toward the commands and app names most often
        // mangled by speech recognition ("open opencode" → "open open card").
        // contextTodos are suggestions, not a closed vocabulary.
        request.contextualStrings = [
            "Jarvis", "opencode", "Visual Studio Code", "code",
            "Safari", "Finder", "Terminal", "Chrome", "Firefox",
            "Spotify", "Messages", "Notes", "Calendar", "Mail",
            "volume", "brightness", "percent", "disable", "what time is it"
        ]
        activeRequest = request

        recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            if let result, result.isFinal {
                let text = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    let safe = text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
                    print("RESULT:" + safe)
                    fflush(stdout)
                }
                self.activeRequest = nil
                // Give the previous task a moment to finish, then start a
                // fresh engine + task so the mic's buffered tail-audio isn't
                // re-recognized as another copy of the same utterance.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                    self?.startEngineAndRecognize()
                }
                return
            }
            // Transient task error (silence, interrupted task, etc.) — restart
            // the cycle rather than killing the whole process. Real permission
            // failures are caught earlier in startFlow() with a clear message.
            if error != nil {
                self.activeRequest = nil
                if self.engine.isRunning { self.engine.stop() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.startEngineAndRecognize()
                }
            }
        }
    }
}

let listener = JarvisListener()
listener.run()