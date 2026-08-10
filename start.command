#!/bin/bash
# Double-click this file in Finder to start the tracker.
# It starts the local server, waits for it to be ready, then opens your
# browser to the right page automatically — closest thing to "clicking an app"
# without needing to package this as a real signed macOS app.

cd "$(dirname "$0")"

echo "Starting Gesture Tracker..."

# start the server in the background
node server.js &
SERVER_PID=$!

# give it a couple seconds to actually start listening before opening the browser
sleep 2

open http://localhost:3000

echo ""
echo "Tracker is running. Leave this window open."
echo "Close this window (or press Ctrl+C) to stop the server."
echo ""

# keep the script alive so the server keeps running as long as this window is open
wait $SERVER_PID
