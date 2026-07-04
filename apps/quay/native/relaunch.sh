#!/bin/sh
# Kill every running spud process, then reopen the freshly built dev bundle. Used by
# `pnpm dev` after a rebuild so you always land on a clean daemon serving new code.
set -e
cd "$(dirname "$0")"

# The launcher and the per-app booter windows both ensure-the-backend-is-up, so kill (and
# wait out) those first — otherwise they'd respawn the daemon we're about to stop. A
# launcher-owned daemon self-exits ~1s after the launcher dies (SPUD_OWNER_PID watchdog),
# but kill the daemon directly anyway: it's immediate, and catches a booter-spawned
# ownerless daemon that would otherwise keep serving stale code across a rebuild. Two
# process shapes: dev runs the script (`bun …/daemon/main.ts`), the shipped bundle runs the
# embedded exe (Spud.app/Contents/MacOS/daemon) with no script arg — kill them all.
kill_wait() {
	pkill -f "$1" 2>/dev/null || true
	while pgrep -f "$1" >/dev/null; do
		sleep 0.1
	done
}

kill_wait 'Spud.app/Contents/MacOS/Spud'
kill_wait 'Spud Apps/.*/Contents/MacOS/'
kill_wait 'daemon/main.ts'
kill_wait 'Spud.app/Contents/MacOS/daemon'

open -n Spud.app
