#!/bin/sh
# Install the built prod bundle into /Applications. Assumes `pnpm build` (--ship-daemon)
# already produced native/Just Computer.app; kills any running copy (you can't replace a running
# .app), replaces /Applications/Just Computer.app, then opens it from there.
set -e
cd "$(dirname "$0")"

[ -d "Just Computer.app" ] || { echo "install.sh: native/Just Computer.app missing — run 'pnpm build' first" >&2; exit 1; }

# Same kill as relaunch.sh: the booter windows + launcher would respawn the daemon, so
# stop them first, then the daemon itself — in both its dev-script and shipped-exe process
# shapes.
kill_wait() {
	pkill -f "$1" 2>/dev/null || true
	while pgrep -f "$1" >/dev/null; do
		sleep 0.1
	done
}

kill_wait 'Just Computer.app/Contents/MacOS/Just Computer'
kill_wait 'Just Computer Apps/.*/Contents/MacOS/'
kill_wait 'daemon/main.ts'
kill_wait 'Just Computer.app/Contents/MacOS/daemon'

rm -rf "/Applications/Just Computer.app"
cp -R "Just Computer.app" "/Applications/Just Computer.app"
echo "installed → /Applications/Just Computer.app"
open -n "/Applications/Just Computer.app"
