#!/bin/sh
# Install the built prod bundle into /Applications. Assumes `pnpm build` (--ship) already
# produced native/Quay.app; kills any running copy (you can't replace a running .app),
# replaces /Applications/Quay.app, then opens it from there.
set -e
cd "$(dirname "$0")"

[ -d Quay.app ] || { echo "install.sh: native/Quay.app missing — run 'pnpm build' first" >&2; exit 1; }

# Same kill as relaunch.sh: the booter windows + launcher would respawn the backend, so
# stop them first, then the backend itself — both backends (daemon + legacy quayd) in both
# their dev-script and shipped-exe process shapes.
kill_wait() {
	pkill -f "$1" 2>/dev/null || true
	while pgrep -f "$1" >/dev/null; do
		sleep 0.1
	done
}

kill_wait 'Quay.app/Contents/MacOS/Quay'
kill_wait 'Quay Apps/.*/Contents/MacOS/'
kill_wait 'daemon/main.ts'
kill_wait 'Quay.app/Contents/MacOS/quay-daemon'
kill_wait 'quayd/main.ts'
kill_wait 'Quay.app/Contents/MacOS/quayd'

rm -rf /Applications/Quay.app
cp -R Quay.app /Applications/Quay.app
echo "installed → /Applications/Quay.app"
open -n /Applications/Quay.app
