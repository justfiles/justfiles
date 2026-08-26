#!/bin/sh
# Install the built prod bundle into /Applications. Assumes `pnpm build` (--ship-daemon)
# already produced native/Kodama.app; kills any running copy (you can't replace a running
# .app), replaces /Applications/Kodama.app, then opens it from there.
set -e
cd "$(dirname "$0")"

[ -d Kodama.app ] || { echo "install.sh: native/Kodama.app missing — run 'pnpm build' first" >&2; exit 1; }

# Same kill as relaunch.sh: the booter windows + launcher would respawn the daemon, so
# stop them first, then the daemon itself — in both its dev-script and shipped-exe process
# shapes.
kill_wait() {
	pkill -f "$1" 2>/dev/null || true
	while pgrep -f "$1" >/dev/null; do
		sleep 0.1
	done
}

kill_wait 'Kodama.app/Contents/MacOS/Kodama'
kill_wait 'Kodama Apps/.*/Contents/MacOS/'
kill_wait 'daemon/main.ts'
kill_wait 'Kodama.app/Contents/MacOS/daemon'

rm -rf /Applications/Kodama.app
cp -R Kodama.app /Applications/Kodama.app
echo "installed → /Applications/Kodama.app"
open -n /Applications/Kodama.app
