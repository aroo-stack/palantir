#!/bin/bash
# Auto-sync: whenever files change in this project, wait for the edit to settle,
# commit, then push to GitHub. Runs forever in the background.
# Start it with:  nohup ./sync_remote.sh >> sync.log 2>&1 &
# (start.command launches this automatically.)

cd "$(dirname "$0")"

# don't let git nag about ignored files (node_modules, logs) on every auto-add
git config advice.addIgnoredFile false 2>/dev/null

POLL_SECONDS=6

diff() {
  git status --porcelain 2>/dev/null | grep -Ev '^.. (node_modules/|\.DS_Store|server\.log|sync\.log)'
}

push_pending() {
  # push anything committed but not yet on GitHub (retries forever)
  if [ "$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 1)" -gt 0 ]; then
    git push 2>>sync.log && echo "[$(date '+%H:%M:%S')] pushed pending commits" || echo "[$(date '+%H:%M:%S')] push failed (will retry)"
  fi
}

while true; do
  sleep "$POLL_SECONDS"
  first="$(diff)"

  if [ -z "$first" ]; then
    push_pending
    continue
  fi

  # Editing in progress — wait for a settled snapshot (two identical polls).
  sleep "$POLL_SECONDS"
  second="$(diff)"
  [ "$second" = "$first" ] || continue

  git add -A -- . ':(exclude)node_modules' ':(exclude).DS_Store' ':(exclude)server.log' ':(exclude)sync.log' 2>>sync.log
  if git diff --cached --quiet; then
    echo "[$(date '+%H:%M:%S')] no new changes"
    continue
  fi
  git commit -q -m "auto-sync $(date '+%Y-%m-%d %H:%M:%S')" 2>>sync.log
  echo "[$(date '+%H:%M:%S')] committed & pushed changes"
  push_pending
done