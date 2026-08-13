"use strict";
const { app, BrowserWindow, session } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 3000;
const SERVER_URL = `http://127.0.0.1:${PORT}`;

let serverProc = null;
let mainWindow = null;

// Chromium ships WebGPU — let the renderer use it for the MediaPipe GPU
// delegate (the same path Chrome uses). Harmless if unsupported.
app.commandLine.appendSwitch("enable-unsafe-webgpu");

function probeServer(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const req = http.get(`${SERVER_URL}/api/health`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

// Run server.js with Electron's own bundled Node (ELECTRON_RUN_AS_NODE), so
// the packaged .app doesn't depend on the user's system node. If something is
// already serving :3000 (e.g. the browser-mode `npm start`), we just use it.
async function startServer() {
  const alreadyUp = await probeServer(1200);
  if (alreadyUp) return;
  const entry = path.join(__dirname, "..", "server.js");
  serverProc = spawn(process.execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stderr.on("data", (d) => console.error("[server]", d.toString().trim()));
  const ok = await probeServer(15000);
  if (!ok) {
    console.error("Local server failed to start on :3000 — the app cannot load.");
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 900,
    minWidth: 760,
    minHeight: 620,
    title: "Local Body Deck — Gesture Tracker",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the tracking rAF loop alive even when another app is in front
      // (occluded) — otherwise Chromium throttles requestAnimationFrame to ~0
      // and gestures can't be detected while the user is in another app.
      backgroundThrottling: false,
    },
  });
  mainWindow.loadURL(SERVER_URL);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Camera/microphone go straight through — the whole app is local.
  const allow = (permission) => ["media", "mediaMain", "mediaSecondary"].includes(permission);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allow(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return allow(permission);
  });

  await startServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill("SIGTERM");
  }
});
