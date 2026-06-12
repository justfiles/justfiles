#!/bin/sh
set -e
cd "$(dirname "$0")"

pkill -f Quay.app/Contents/MacOS/Quay 2>/dev/null || true
while pgrep -f Quay.app/Contents/MacOS/Quay >/dev/null; do
	sleep 0.1
done
open -n Quay.app
