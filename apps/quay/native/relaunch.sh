#!/bin/sh
# Kill every running quay process, then reopen the freshly built dev bundle. Used by
# `pnpm dev` after a rebuild so you always land on a clean daemon serving new code.
set -e
cd "$(dirname "$0")"

# The launcher and the per-app booter windows both ensure-quayd-is-up, so kill (and wait
# out) those first — otherwise they'd respawn the daemon we're about to stop. Then stop
# the daemon itself; it survives launcher restarts (it only ensure-runs), so a long-lived
# quayd would keep serving stale code across a rebuild. The daemon has two process shapes:
# dev runs the script (`node|bun …/quayd/main.ts`), the --ship bundle runs the embedded exe
# (Quay.app/Contents/MacOS/quayd) with no script arg — kill both.
kill_wait() {
	pkill -f "$1" 2>/dev/null || true
	while pgrep -f "$1" >/dev/null; do
		sleep 0.1
	done
}

kill_wait 'Quay.app/Contents/MacOS/Quay'
kill_wait 'Quay Apps/.*/Contents/MacOS/'
kill_wait 'quayd/main.ts'
kill_wait 'Quay.app/Contents/MacOS/quayd'

open -n Quay.app
