# Gesture Tracker — Local Server Version

This runs your hand/face/body tracker as a small local web server instead of
a packaged app. No Electron, no app bundle, no code signing, no cost, no
macOS security warnings — because a plain Node script isn't something
Gatekeeper treats as "an app" to scan.

## Why this version instead of the Electron one

The Electron build got flagged by macOS as malware (a known, documented false
positive for unsigned Electron dev builds — but not something worth fighting
without paying for an Apple Developer account). This version sidesteps that
entirely: it's just `node` running a script and listening on a port, exactly
like every `npm install` you've already run.

## Setup

Delete the old `main.js` and `preload.js` if they're still in this folder —
they were Electron-specific and aren't used anymore.

```
cd gesture-tracker-app
npm install
npm start
```

Then open your regular browser (Safari, Chrome, whatever) and go to:

```
http://localhost:3000
```

Everything works the same as before — hand/face/body tracking, ASL
fingerspelling, all the gestures. Plus one new thing:

**"Pinch dims real screen brightness 🔅"** — this toggle only appears once
the page detects the local server is running (which it will be, since you
just started it). Enable it, pinch to dim your actual screen to 15%, pinch
again to restore it.

**"Voice control 🎤"** — say "volume" out loud, then for the next ~8 seconds
your hand's height controls real system volume (raise your hand = louder,
lower it = quieter). Read the privacy section below before turning this on —
it's a real trade-off, not a free feature.

## About the voice control — please read this before enabling it

Everything else in this project runs entirely on your machine. Voice
recognition is different, and it's worth being clear about that rather than
letting it slide in quietly:

- **By default, Chrome and Safari send your audio to Google's or Apple's
  servers** to turn it into text. That's how the browser's built-in speech
  recognition works out of the box — this isn't something this code can
  change on its own.
- The code requests on-device processing (`processLocally: true`) where the
  browser supports it, which keeps audio and transcription fully on your
  machine when it works. But whether that actually applies depends on your
  specific browser version and whether it has an on-device language model
  installed — it isn't guaranteed.
- **How to check what's actually happening on your setup:**
  - **Safari**: the first time you enable voice control, Safari will show a
    permission prompt. Read its wording carefully — it will say if it's
    sending audio to Apple to process.
  - **Chrome**: visit `chrome://components` and look for "SODA" (Speech
    On-Device API) or a similar on-device speech model. If it's not listed
    or not downloaded, your audio is going to Google's servers.
- If none of that sits right with you, just leave "Voice control" off —
  everything else in this project (brightness, all the gestures, ASL,
  tracking) has no such trade-off and stays fully local either way.

## How the brightness control actually works

Your browser can't touch OS-level brightness on its own — that's still true,
sandboxing hasn't changed. What's different: the page now talks to
`server.js` (the Node process you started with `npm start`) over
`http://localhost:3000/api/brightness`. That Node process isn't sandboxed
the way a browser tab is, so it can call the `brightness` npm package
directly and actually change your screen. The browser is just asking a
program on your own machine to do something for it — like any other local
web app.

## Known limitation

`brightness` (the package doing the actual OS work) is old — last published
about a decade ago — and `npm audit` will flag high-severity vulnerabilities
in its dependency chain. It still works for macOS and Windows, but isn't
actively maintained. If you want a more current alternative, or run into
issues on your OS, let me know.

Volume control uses macOS's built-in AppleScript (`osascript`) directly, no
extra package needed — but that also means it's macOS-only.

To stop the server, go back to the terminal and press `Ctrl+C`.

## What's next

Real window-switching (the original ask) could be added the same way — a new
`/api/window` endpoint on this same server, using OS-specific tooling
(AppleScript on macOS via `osascript`, since you're on a Mac). Say the word
if you want that built out.

## Files

- `index.html` — the tracker UI and all detection/gesture logic
- `server.js` — the local Node server: serves the page and handles real
  brightness requests
- `package.json` — the one dependency (`brightness`)

## Git auto-sync

`sync_remote.sh` runs in the background (started automatically by
`start.command`). Whenever files change here, it waits ~12 seconds for the
edit to settle, commits with an `auto-sync` message, and pushes to the
private GitHub repo. Nothing to do on your side. `node_modules/` and logs
are git-ignored — after cloning, run `npm install` once.

## Object detection (local)

Tick "Detect objects" in the Tracking card and hold up a phone, book, bottle,
etc. — a yellow box with the label (COCO classes, incl. book & cell phone) is
drawn over the live camera feed. Model: MediaPipe EfficientDet-Lite0 (int8),
vendored in `models/`, fully offline.
