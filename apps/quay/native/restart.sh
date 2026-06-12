#!/bin/sh
set -e
cd "$(dirname "$0")"

# Stop every quay process for a clean restart. The launcher and the per-app
# booter windows both ensure-quayd-is-up, so kill (and wait out) those first —
# otherwise they'd respawn the daemon we're about to stop. Then stop the daemon
# (quayd) itself: restart.sh used to leave it running, so a long-lived quayd
# kept serving stale code (capability registry, memoized declarations, loaded
# reducer workers) across a rebuild.
kill_wait() {
	pkill -f "$1" 2>/dev/null || true
	while pgrep -f "$1" >/dev/null; do
		sleep 0.1
	done
}

kill_wait 'Quay.app/Contents/MacOS/Quay'
kill_wait 'Quay Apps/.*/Contents/MacOS/'
kill_wait 'quayd/main.ts'

open -n Quay.app
