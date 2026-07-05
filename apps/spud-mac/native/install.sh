#!/bin/sh
# Install the built prod bundle into /Applications. Assumes `pnpm build` (--ship-daemon)
# already produced native/Spud.app; kills any running copy (you can't replace a running
# .app), replaces /Applications/Spud.app, then opens it from there.
set -e
cd "$(dirname "$0")"

[ -d Spud.app ] || { echo "install.sh: native/Spud.app missing — run 'pnpm build' first" >&2; exit 1; }

# Same kill as relaunch.sh: the booter windows + launcher would respawn the daemon, so
# stop them first, then the daemon itself — in both its dev-script and shipped-exe process
# shapes.
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

rm -rf /Applications/Spud.app
cp -R Spud.app /Applications/Spud.app
echo "installed → /Applications/Spud.app"
open -n /Applications/Spud.app
