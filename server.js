const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec, execFile, spawn, execSync } = require("child_process");

const PORT = 3000;
const ROOT = __dirname;

// ----------------------------------------------------------------------------
// Volume control (macOS AppleScript, no extra package). Fully local.
// ----------------------------------------------------------------------------
function getSystemVolume() {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", "output volume of (get volume settings)"], (err, stdout) => {
      if (err) return reject(err);
      resolve(parseInt(stdout.trim(), 10));
    });
  });
}
function setSystemVolume(level0to100) {
  const clamped = Math.max(0, Math.min(100, Math.round(level0to100)));
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", `set volume output volume ${clamped}`], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function lockScreen() {
  return new Promise((resolve, reject) => {
    exec("pmset displaysleepnow", (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function sleepSystem() {
  return new Promise((resolve, reject) => {
    exec("pmset sleepnow", (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---- Spoken replies (macOS `say`) ----
// J.A.R.V.I.S.-flavoured voice: Daniel (British male) if installed, else the
// system default. The user can pick any installed voice from the UI.
let SAY_VOICE = null;
const SAY_RATE = 168; // words per minute — measured, not a frantic Siri
const INSTALLED_VOICES = [];
try {
  const list = execSync("say -v '?'", { encoding: "utf8" });
  for (const line of list.split("\n")) {
    // columns are: <name>  <lang>  # <sample sentence>
    const parts = line.split(/\s{2,}/);
    const name = parts[0] && parts[0].trim();
    const lang = parts[1] && parts[1].trim();
    const sample = (parts[2] || "").replace(/^#\s*/, "").trim();
    if (name && lang) INSTALLED_VOICES.push({ name, lang, sample });
  }
  if (INSTALLED_VOICES.some(v => v.name === "Daniel")) SAY_VOICE = "Daniel";
} catch (e) { /* no list, fall back to the system default */ }

function isInstalledVoice(name) {
  return INSTALLED_VOICES.some(v => v.name === name);
}

// `say` run as a background child can cut the last syllable (the synthesizer
// tears down before the final audio buffer flushes). Rendering to a file and
// playing it with `afplay` always plays the whole phrase. One speak at a time:
// concurrent `say` processes also interrupt each other mid-word.
let speakQueue = Promise.resolve();
let speakFileSeq = 0;

function speakText(text, voice) {
  const safeText = String(text).replace(/["'`$\\]/g, "").slice(0, 240);
  if (!safeText) return Promise.resolve();
  const chosen = (voice && isInstalledVoice(voice)) ? voice : SAY_VOICE;
  const args = [];
  if (chosen) args.push("-v", chosen);
  args.push("-r", String(SAY_RATE));

  const job = () => new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `jarvis-speak-${process.pid}-${Date.now()}-${speakFileSeq++}.aiff`);
    const cleanup = () => { try { fs.unlinkSync(file); } catch (e) { /* already gone */ } };
    execFile("say", [...args, "-o", file, safeText], (err) => {
      if (err) { cleanup(); return reject(err); }
      execFile("afplay", [file], (playErr) => {
        cleanup();
        playErr ? reject(playErr) : resolve();
      });
    });
  });
  speakQueue = speakQueue.then(job, job);
  return speakQueue.catch(() => {});
}

function openApp(appName) {
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", appName], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

function currentTime() {
  return new Promise((resolve, reject) => {
    exec('date "+%I:%M %p"', (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

function batteryPercent() {
  return new Promise((resolve, reject) => {
    exec("pmset -g batt", (err, stdout) => {
      if (err) return reject(err);
      const m = stdout.match(/(\d+)%/);
      if (!m) return reject(new Error("couldn't parse battery"));
      resolve(parseInt(m[1], 10));
    });
  });
}

function diskUsage() {
  return new Promise((resolve, reject) => {
    exec("df -h / ", (err, stdout) => {
      if (err) return reject(err);
      const lines = stdout.trim().split("\n");
      const parts = lines[lines.length - 1].split(/\s+/);
      resolve({ size: parts[1], used: parts[2], available: parts[3], usedPercent: parts[4] });
    });
  });
}

// ----------------------------------------------------------------------------
// Screen brightness. The `brightness` npm package is old and fails to read many
// modern displays ("This display is not supported") — it's optional. Everything
// else (lock, sleep, voice, media) is independent of it.
// ----------------------------------------------------------------------------
let brightness = null;
try {
  brightness = require("brightness");
} catch (e) {
  console.warn("brightness module not available — brightness endpoints will just report errors:", e.message);
}
let brightnessWorks = false;
let brightnessCheck = null;
function ensureBrightnessCheck() {
  if (!brightnessCheck) {
    brightnessCheck = brightness
      ? brightness.get().then(() => { brightnessWorks = true; }).catch(() => { brightnessWorks = false; })
      : Promise.resolve((brightnessWorks = false));
  }
  return brightnessCheck;
}

// ----------------------------------------------------------------------------
// Local on-device speech: the Swift helper. The server owns the process and
// streams recognized lines to the browser via polling.
// ----------------------------------------------------------------------------
const SWIFT_SRC = path.join(ROOT, "speech_jarvis.swift");
const JARVIS_BIN = path.join(ROOT, "jarvis_speech");
let jarvisProc = null;
let speechLines = [];
let speechSeq = 0;
let speechBase = 0; // how many lines have been shifted off the front of speechLines
let speechError = null;

function compileSpeechBinary() {
  return new Promise((resolve) => {
    execFile("swiftc", ["-O", "-o", JARVIS_BIN, SWIFT_SRC], (err, _stdout, stderr) => {
      if (err) {
        const msg = (stderr || "swiftc failed").trim().split("\n").slice(-2).join(" | ");
        resolve({ ok: false, error: msg });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

async function ensureSpeechBinary() {
  if (!fs.existsSync(SWIFT_SRC)) return { ok: false, error: "speech_jarvis.swift is missing" };
  if (fs.existsSync(JARVIS_BIN)) {
    const srcTime = fs.statSync(SWIFT_SRC).mtimeMs;
    const binTime = fs.statSync(JARVIS_BIN).mtimeMs;
    if (binTime >= srcTime) return { ok: true };
  }
  return compileSpeechBinary();
}

function startSpeechProcess() {
  return new Promise((resolve) => {
    if (jarvisProc && jarvisProc.exitCode === null) {
      return resolve({ ok: true }); // already listening
    }
    speechLines = [];
    speechSeq = 0;
    speechBase = 0;
    speechError = null;
    let child;
    try {
      child = spawn(JARVIS_BIN, [], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: "could not launch local speech: " + e.message });
    }
    jarvisProc = child;
    child.stdout.setEncoding("utf8");
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("RESULT:")) {
          const text = line.slice(7).trim();
          if (text) {
            speechLines.push(text);
            if (speechLines.length > 200) { speechLines.shift(); speechBase++; }
            speechSeq++;
          }
        } else if (line.startsWith("ERR:")) {
          speechError = line.slice(4).trim();
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      if (!speechError) speechError = d.toString().trim().slice(0, 200);
    });
    child.on("exit", () => {
      jarvisProc = null;
      if (!speechError) speechError = "local speech exited unexpectedly";
    });
    // If it dies within a second, it almost certainly can't get permissions.
    setTimeout(() => {
      if (jarvisProc && speechError) {
        jarvisProc.kill();
        jarvisProc = null;
      }
    }, 800);
    resolve({ ok: true });
  });
}

function stopSpeechProcess() {
  if (jarvisProc) {
    try { jarvisProc.kill(); } catch (e) { /* ignore */ }
    jarvisProc = null;
  }
  speechLines = [];
  speechSeq = 0;
  speechBase = 0;
  speechError = null;
}

// ----------------------------------------------------------------------------
// App-aware media control. Native apps (Spotify, Music, VLC) via AppleScript;
// browser video (YouTube, Netflix, …) through the browser's JS bridge. All
// local, nothing leaves the Mac.
// ----------------------------------------------------------------------------
function osascript(lines) {
  return new Promise((resolve, reject) => {
    const args = [];
    for (const line of lines) args.push("-e", line);
    execFile("osascript", args, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 300)));
      resolve(stdout.trim());
    });
  });
}

// Detect running apps via `ps` (no Automation permission required — Apple
// events to System Events would be).
function runningApps() {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-o", "comm="], (err, stdout) => {
      if (err) return reject(err);
      const set = new Set();
      for (const line of stdout.split("\n")) {
        const base = path.basename(line.trim());
        if (base) set.add(base);
      }
      resolve(set);
    });
  });
}

// macOS returns -1743 when the caller isn't authorised to send Apple events
// (Automation permission). Map it to an actionable message.
function automationError(e) {
  if (/not authorised|Not authorised|-1743|not allowed to send Apple events/i.test(String(e && e.message))) {
    return new Error("Media control needs Automation permission — allow your terminal/editor to control Spotify, Music and your browser in System Settings → Privacy & Security → Automation, then try again.");
  }
  return e;
}

const MEDIA_NATIVE = {
  spotify: { app: "Spotify", cmds: { play: "play", pause: "pause", playpause: "playpause", next: "next track", previous: "previous track" } },
  music: { app: "Music", cmds: { play: "play", pause: "pause", playpause: "playpause", next: "next track", previous: "previous track" } },
  itunes: { app: "Music", cmds: { play: "play", pause: "pause", playpause: "playpause", next: "next track", previous: "previous track" } },
  vlc: { app: "VLC", cmds: { play: "play", pause: "pause", playpause: "playpause", next: "next", previous: "previous" } },
  "quicktime player": { app: "QuickTime Player", cmds: { play: "play", pause: "pause", playpause: "playpause", next: null, previous: null } }
};

const BROWSER_APPS = { youtube: "YouTube", netflix: "Netflix", twitch: "Twitch", prime: "Prime Video", disney: "Disney+", hulu: "Hulu" };
const MEDIA_ACTIONS = ["play", "pause", "playpause", "next", "previous", "playlist"];

// Spotify's AppleScript has no playlist objects, but `play track` accepts a
// URI. Music/iTunes has a real `play playlist "name"` command. Liked Songs is
// a per-user collection URI (spotify:user:USER:collection) — the username is
// read from Spotify itself the first time, then cached in memory.
let spotifyUsername = null;

function spotifyPlaylistUri(input) {
  const s = String(input).trim();
  if (/^spotify:playlist:/i.test(s)) return s;
  if (/^spotify:user:.+:collection/i.test(s)) return s;
  const m = s.match(/playlist[/:]([A-Za-z0-9]+)/i);
  if (m) return "spotify:playlist:" + m[1];
  const c = s.match(/user[/:]([A-Za-z0-9]+)[/:]collection/i);
  if (c) return "spotify:user:" + c[1] + ":collection";
  return null;
}

async function spotifyCollectionUri() {
  if (spotifyUsername) return "spotify:user:" + spotifyUsername + ":collection";
  try {
    const out = await osascript([
      'tell application "Spotify"',
      "  get username",
      "end tell"
    ]);
    const u = out.trim();
    if (/^[A-Za-z0-9]+$/.test(u)) {
      spotifyUsername = u;
      return "spotify:user:" + u + ":collection";
    }
  } catch (e) { /* fall through — caller will explain */ }
  return null;
}

function isLikedSongsKeyword(input) {
  return /liked songs|^liked$|saved songs|^saved$|my music|^collection$|^likes$/i.test(String(input).trim());
}

function browserVideoJS(action) {
  switch (action) {
    case "play": return "(()=>{const v=document.querySelector('video');if(v){v.muted=false;v.play();return 'played';}return 'no-video';})()";
    case "pause": return "(()=>{const v=document.querySelector('video');if(v){v.pause();return 'paused';}return 'no-video';})()";
    case "playpause": return "(()=>{const v=document.querySelector('video');if(v){if(v.paused){v.play();return 'played';}v.pause();return 'paused';}return 'no-video';})()";
    case "next": return "(()=>{const n=document.querySelector('.ytp-next-button');if(n){n.click();return 'next';}const v=document.querySelector('video');if(v&&v.duration){v.currentTime=v.duration;return 'seek-end';}return 'no-next';})()";
    case "previous": return "(()=>{const v=document.querySelector('video');if(v){v.currentTime=0;return 'restart';}return 'no-video';})()";
    default: return null;
  }
}

async function runBrowserMedia(browserApp, action) {
  const js = browserVideoJS(action);
  if (!js) return { error: `Can't ${action} inside ${BROWSER_APPS[browserApp] || browserApp}` };
  const apps = await runningApps();
  let browser = null;
  for (const b of ["Google Chrome", "Safari", "Microsoft Edge", "Firefox"]) {
    if (apps.has(b)) { browser = b; break; }
  }
  if (!browser) return { error: `No browser is running to control ${BROWSER_APPS[browserApp] || browserApp}` };
  try {
    let result;
    if (browser === "Google Chrome") {
      result = await osascript([
        "tell application \"Google Chrome\"",
        `  execute front window's active tab javascript ${JSON.stringify(js)}`,
        "end tell"
      ]);
    } else if (browser === "Safari") {
      result = await osascript([
        "tell application \"Safari\"",
        `  do JavaScript ${JSON.stringify(js)} in front document`,
        "end tell"
      ]);
    } else {
      return { error: `Controlling ${browser} isn't supported yet — switch to Chrome or Safari for ${BROWSER_APPS[browserApp]}` };
    }
    // The injected JS signals "nothing to control here" with no-* sentinels.
    if (result === "no-video") return { error: `No video is playing in the ${browser} tab for ${BROWSER_APPS[browserApp]}` };
    if (result === "no-next") return { error: `I couldn't find the next button on ${BROWSER_APPS[browserApp]}` };
    return { detail: result, browser, app: BROWSER_APPS[browserApp] };
  } catch (e) {
    throw automationError(e);
  }
}

async function runMediaControl(action, app, uri) {
  let native = null;
  let browserApp = null;
  if (app) {
    const lower = String(app).toLowerCase().replace(/\s+/g, " ");
    if (MEDIA_NATIVE[lower]) native = MEDIA_NATIVE[lower];
    else if (BROWSER_APPS[lower]) browserApp = lower;
    else return { error: `I don't know how to control ${app}` };
  } else {
    const apps = await runningApps();
    for (const key of Object.keys(MEDIA_NATIVE)) {
      if (apps.has(MEDIA_NATIVE[key].app)) { native = MEDIA_NATIVE[key]; break; }
    }
    if (!native) browserApp = "youtube"; // best guess: video in a browser tab
  }

  if (native) {
    if (action === "playlist") {
      if (!uri) return { error: `Tell me which playlist — a Spotify link or URI, or a Music playlist name` };
      const liked = isLikedSongsKeyword(uri);
      let cmd;
      if (native.app === "Spotify") {
        let u = null;
        if (liked) {
          u = await spotifyCollectionUri();
          if (!u) return { error: `I couldn't read your Spotify username — paste your Liked Songs link (Spotify → Liked Songs → share → copy link) into the Play playlist step instead.` };
        } else {
          u = spotifyPlaylistUri(uri);
          if (!u) return { error: `I couldn't read "${uri}" as a Spotify playlist — paste a playlist link like https://open.spotify.com/playlist/…` };
        }
        cmd = `play track ${JSON.stringify(u)}`;
      } else {
        cmd = `play playlist ${JSON.stringify(liked ? "Liked Songs" : uri)}`;
      }
      try {
        await osascript([
          `tell application ${JSON.stringify(native.app)}`,
          `  ${cmd}`,
          "end tell"
        ]);
      } catch (e) {
        throw automationError(e);
      }
      return { app: native.app, browser: null, detail: "playlist" };
    }
    const cmd = native.cmds[action];
    if (!cmd) return { error: `The ${native.app} app can't ${action}` };
    try {
      await osascript([
        `tell application ${JSON.stringify(native.app)}`,
        `  ${cmd}`,
        "end tell"
      ]);
    } catch (e) {
      throw automationError(e);
    }
    return { app: native.app, browser: null };
  }
  return runBrowserMedia(browserApp, action);
}

// ----------------------------------------------------------------------------
// Send an iMessage. Messages has a native AppleScript API — no System Events,
// no keystrokes, just an Apple event to the Messages app (needs one-time
// Automation permission for Messages). WhatsApp/Telegram have no scripting
// API, so those are routed to Messages with a clear note instead.
// ----------------------------------------------------------------------------
function sendIMessage(to, message) {
  const clean = (s) => String(s).replace(/[\\"]/g, "").slice(0, 160);
  const toClean = clean(to);
  const msgClean = clean(message);
  return new Promise((resolve, reject) => {
    execFile("osascript", [
      "-e", "tell application \"Messages\"",
      "-e", "  set targetBuddy to buddy " + JSON.stringify(toClean),
      "-e", "  send " + JSON.stringify(msgClean) + " to targetBuddy",
      "-e", "end tell"
    ], (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message).trim().slice(0, 300);
        if (/not authorised|Not authorised|-1743/i.test(detail)) {
          return reject(new Error("Messaging needs Automation permission for Messages — allow it in System Settings → Privacy & Security → Automation, then try again."));
        }
        return reject(new Error(detail || "Messages couldn't send to that contact"));
      }
      resolve();
    });
  });
}

// ----------------------------------------------------------------------------
// HTTP plumbing
// ----------------------------------------------------------------------------
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooBig = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > maxBytes) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => tooBig ? reject(new Error("body too large")) : resolve(body));
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".tflite": "application/octet-stream",
  ".gz": "application/gzip",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // ---------- API ----------
  if (url.pathname === "/api/health" && req.method === "GET") {
    await ensureBrightnessCheck();
    return sendJson(res, 200, { ok: true, brightness: brightnessWorks, localSpeech: fs.existsSync(JARVIS_BIN) });
  }

  if (url.pathname === "/api/brightness" && req.method === "GET") {
    if (!brightness) return sendJson(res, 500, { error: "brightness module not available" });
    try {
      const level = await brightness.get();
      return sendJson(res, 200, { level });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/brightness" && req.method === "POST") {
    if (!brightness) return sendJson(res, 500, { error: "brightness module not available" });
    try {
      const { value } = JSON.parse(await readBody(req));
      if (typeof value !== "number" || value < 0 || value > 1) return sendJson(res, 400, { error: "value must be 0..1" });
      await brightness.set(value);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/volume" && req.method === "GET") {
    try {
      const level = await getSystemVolume();
      return sendJson(res, 200, { level });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/volume" && req.method === "POST") {
    try {
      const { value } = JSON.parse(await readBody(req));
      if (typeof value !== "number" || value < 0 || value > 100) return sendJson(res, 400, { error: "value must be 0..100" });
      await setSystemVolume(value);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/lock" && req.method === "POST") {
    try {
      await lockScreen();
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/sleep" && req.method === "POST") {
    try {
      await sleepSystem();
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/speak" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const text = body.text;
      const voice = typeof body.voice === "string" ? body.voice.trim() : null;
      if (typeof text !== "string" || !text.trim()) return sendJson(res, 400, { error: "text must be a non-empty string" });
      await speakText(text, voice);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/voices" && req.method === "GET") {
    return sendJson(res, 200, { voices: INSTALLED_VOICES, default: SAY_VOICE });
  }

  if (url.pathname === "/api/open-app" && req.method === "POST") {
    try {
      const { appName } = JSON.parse(await readBody(req));
      if (typeof appName !== "string" || !appName.trim() || appName.length > 100) return sendJson(res, 400, { error: "appName invalid" });
      await openApp(appName.trim());
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/media" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const action = String(body.action || "").toLowerCase();
      const app = typeof body.app === "string" && body.app.trim() ? body.app.trim().toLowerCase() : null;
      const uri = typeof body.uri === "string" && body.uri.trim() ? body.uri.trim() : null;
      if (!MEDIA_ACTIONS.includes(action)) return sendJson(res, 400, { error: "unknown action" });
      const result = await runMediaControl(action, app, uri);
      if (result.error) return sendJson(res, 200, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/text" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const app = String(body.app || "Messages").trim();
      const to = String(body.to || "").trim().slice(0, 80);
      const message = String(body.message || "").trim().slice(0, 160);
      if (!to || !message) return sendJson(res, 400, { error: "to and message are required" });
      if (app.toLowerCase() !== "messages") {
        return sendJson(res, 200, {
          ok: false,
          error: `I can't type inside ${app} — it has no scripting API. I can send it through Messages instead.`
        });
      }
      await sendIMessage(to, message);
      return sendJson(res, 200, { ok: true, app: "Messages", to });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/time" && req.method === "GET") {
    try {
      const text = await currentTime();
      return sendJson(res, 200, { text });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/battery" && req.method === "GET") {
    try {
      const percent = await batteryPercent();
      return sendJson(res, 200, { percent });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/disk" && req.method === "GET") {
    try {
      const usage = await diskUsage();
      return sendJson(res, 200, usage);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url.pathname === "/api/netinfo" && req.method === "GET") {
    try {
      return sendJson(res, 200, { lan: lanIPs() });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // ---------- Local speech ----------
  if (url.pathname === "/api/voice/start" && req.method === "POST") {
    const built = await ensureSpeechBinary();
    if (!built.ok) return sendJson(res, 200, { ok: false, error: built.error });
    const started = await startSpeechProcess();
    return sendJson(res, 200, started);
  }

  if (url.pathname === "/api/voice/stop" && req.method === "POST") {
    stopSpeechProcess();
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/voice/poll" && req.method === "GET") {
    // `since` is a total-emitted counter, not an index into the ring buffer —
    // lines evicted from the front (speechBase) translate the counter to the
    // current array. Without this, results were silently dropped after 200.
    const since = parseInt(url.searchParams.get("seq") || "0", 10);
    const from = Math.max(0, since - speechBase);
    return sendJson(res, 200, {
      seq: speechSeq,
      lines: speechLines.slice(from),
      running: !!(jarvisProc && jarvisProc.exitCode === null),
      error: speechError
    });
  }

  // ---------- Static files (all assets are local on purpose) ----------
  if (req.method !== "GET") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Bad request");
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }
  fs.stat(filePath, (err, stat) => {
    if (err || stat.isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store" // always fresh while developing; local anyway
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// Bind to loopback only: the API can lock the screen, launch apps and change
// the volume — that should never be reachable from the rest of the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Tracker running — open http://localhost:${PORT} in your browser`);
  console.log("Press Ctrl+C to stop.");
  if (fs.existsSync(JARVIS_BIN)) console.log("Local on-device speech helper is built (jarvis_speech).");
  else console.log("Local speech helper not compiled yet — will build on first voice start (needs Xcode CLT / swiftc).");
});

process.on("SIGINT", () => { stopSpeechProcess(); process.exit(0); });
process.on("SIGTERM", () => { stopSpeechProcess(); process.exit(0); });