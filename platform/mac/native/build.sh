#!/bin/sh
# Build the native shell — one binary, two modes (booter + launcher).
# Command Line Tools only (no full Xcode): SwiftPM compiles, this script bundles.
#
#   ./build.sh Code          # a booter bundle ./Code.app (mock target, own identity)
#   ./build.sh --launcher    # dev launcher ./Just Computer.app — spawns the daemon from source
#   ./build.sh --ship-daemon # prod ./Just Computer.app — self-contained daemon exe + Vite client
#   ./build.sh --release …   # optimise the binaries for shipping (default: debug)
#
# --launcher and --ship-daemon build the Vite client (ui/dist/client, the daemon's browser
# surfaces) — there is no separate `assets` step. The
# pnpm scripts (dev/build) build the workspace app deps via turbo first; this script only
# does the native shell + assets.
#
# `swift build` (Package.swift) discovers the Swift sources under Sources/ and
# produces two binaries — shell (the shared booter+launcher) and makeicon.
# We copy both into ./build/, a stable, gitignored handoff dir where the daemon finds
# them to materialise the per-app `.app` bundles (see daemon/materialize.ts).
set -e
cd "$(dirname "$0")"

CONFIG=debug
# Consume leading option flags (--release); leave the positional
# (Name | --launcher | --ship-daemon) in "$1" for the dispatch case at the bottom.
while :; do
	case "${1:-}" in
		-r | --release) CONFIG=release; shift ;;
		*) break ;;
	esac
done

BUILD="$(pwd)/build"
mkdir -p "$BUILD"
BIN="$BUILD/shell"
ICON="$BUILD/makeicon"

# Compile once via SwiftPM (incremental — only changed sources recompile), then
# publish the two binaries into ./build/. The launcher's UserNotifications link
# lives in Package.swift now.
swift build -c "$CONFIG"
bin="$(swift build -c "$CONFIG" --show-bin-path)"
cp "$bin/shell" "$BIN"
cp "$bin/makeicon" "$ICON" 2>/dev/null || ICON=""

emit_plist() { # name bundle_id [app_id] [lsui]
	cat <<-EOF
		<?xml version="1.0" encoding="UTF-8"?>
		<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
		<plist version="1.0">
		<dict>
			<key>CFBundleName</key><string>$1</string>
			<key>CFBundleDisplayName</key><string>$1</string>
			<key>CFBundleIdentifier</key><string>$2</string>
			<key>CFBundleExecutable</key><string>$1</string>
			<key>CFBundlePackageType</key><string>APPL</string>
			<key>CFBundleVersion</key><string>1</string>
			<key>CFBundleShortVersionString</key><string>1.0</string>
			<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
			<key>LSMinimumSystemVersion</key><string>12.0</string>
			<key>NSHighResolutionCapable</key><true/>
			<key>CFBundleIconFile</key><string>AppIcon</string>
			<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
	EOF
	[ -n "$3" ] && printf '\t<key>AppId</key><string>%s</string>\n' "$3"
	[ "$4" = "1" ] && printf '\t<key>LSUIElement</key><true/>\n'
	printf '</dict>\n</plist>\n'
}

make_icon() { # app_path letter
	[ -n "$ICON" ] || return 0
	set="$(mktemp -d)/AppIcon.iconset"
	mkdir -p "$set"
	"$ICON" 512 "$set/icon_512x512.png" "$2" 2>/dev/null || return 0
	"$ICON" 1024 "$set/icon_512x512@2x.png" "$2" 2>/dev/null || true
	iconutil -c icns "$set" -o "$1/Contents/Resources/AppIcon.icns" 2>/dev/null || true
}

make_bundle() { # app_path name bundle_id [app_id] [lsui]
	app="$1"
	rm -rf "$app"
	mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
	cp "$BIN" "$app/Contents/MacOS/$2"
	cp ../../../packages/design/assets/app_store.svg "$app/Contents/Resources/AppStore.svg"
	emit_plist "$2" "$3" "$4" "$5" >"$app/Contents/Info.plist"
	make_icon "$app" "$(printf '%s' "$2" | cut -c1)"
	codesign --force --sign - "$app" 2>/dev/null || true
}

# Stamp the daemon spawn keys into the launcher plist. The daemon is Bun-only (Bun.serve,
# pub/sub, Bun.file), so the launcher always spawns it under bun: DaemonRuntime=<bun>,
# DaemonArgs=[] (Bun runs TS + ?raw natively), DaemonScript is the daemon entrypoint.
# Daemon.spawn() (Launcher.swift) execs these verbatim.
stamp_daemon() { # plist
	plist="$1"
	daemon="$(cd ../daemon && pwd)"
	/usr/libexec/PlistBuddy -c "Add :DaemonScript string $daemon/main.ts" "$plist" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :DaemonArgs array" "$plist" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :DaemonRuntime string $(command -v bun)" "$plist" 2>/dev/null || true
}

build_launcher() {
	app="Just Computer.app"
	make_bundle "$app" "Just Computer" "app.justfiles.frieren.host" "" "1"
	# The daemon serves its browser surfaces straight from Vite's ui/dist/client (no ship-time
	# bundling), so build that tree — the dev daemon reads it via CLIENT_DIR (main.ts).
	(cd .. && pnpm run ui:build >/dev/null)
	# Dev wiring: how the launcher spawns the daemon from source (Command Line Tools have no
	# packaged exe). Stamp the runtime keys; Daemon.spawn() execs them verbatim.
	stamp_daemon "$app/Contents/Info.plist"
	codesign --force --sign - "$app" 2>/dev/null || true # re-sign after adding assets
	echo "built $app (launcher, daemon from source)"
}

build_booter() { # Name
	name="$1"
	# The bundle id IS the app id for ids in our namespace (see daemon/materialize.ts).
	id="justfiles.$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
	app="$name.app"
	make_bundle "$app" "$name" "$id" "$id" ""
	echo "built $app (booter, id=$id)"
}

# A self-contained, shippable Just Computer.app backed by the daemon (platform/mac/daemon): the
# launcher binary + an embedded bun-compiled daemon exe (arm64) + the on-disk resources the
# daemon reads, under Resources/. The daemon does zero frontend bundling: Vite builds the
# browser surfaces (launcher / chat / app shell + assets) into
# ui/dist/client, which rides on disk beside the exe as Resources/client. Paths resolve
# through FRIEREN_SHIPPED.
build_ship_daemon() {
	app="Just Computer.app"
	make_bundle "$app" "Just Computer" "app.justfiles.frieren.host" "" "1"
	res="$app/Contents/Resources"
	exe="$(pwd)/$app/Contents/MacOS/daemon"

	# 1. The self-contained daemon exe (arm64) → Contents/MacOS/daemon.
	(cd .. && bun daemon/build-exe.ts --outfile "$exe" --target bun-darwin-arm64)
	# 2. Browser surfaces (launcher / chat / app shell + hashed /assets/*) built by Vite into
	#    ui/dist/client → Resources/client, where the
	#    daemon's CLIENT_DIR resolves them when shipped. Rebuild first (a clean Vite build
	#    empties dist/client) so a stale or absent tree can never ship.
	(cd .. && pnpm run ui:build >/dev/null)
	mkdir -p "$res/client" && cp -R ../ui/dist/client/. "$res/client/"
	# 3. The shared booter binary + icon tool → Resources/build. materialize.ts copies the
	#    booter into each projected ~/Applications/Just Computer Apps/*.app; without it the daemon logs
	#    "booter missing" and skips projection entirely (resources.ts resolves BUILD_DIR here
	#    when shipped).
	mkdir -p "$res/build" && cp "$BIN" "$res/build/shell"
	[ -n "$ICON" ] && cp "$ICON" "$res/build/makeicon"
	# 4. The agent's project docs (repo-root docs/*.md) → Resources/docs, where the daemon's
	#    DOCS_DIR resolves them for the `read_doc` tool with no repo at runtime. Flat copy of
	#    every .md; the @justfiles/agent DOCS catalogue decides which ids are surfaced.
	mkdir -p "$res/docs" && cp ../../../docs/*.md "$res/docs/"
	# 5. Spawn the embedded exe verbatim — no runtime, no args, no script. DaemonRuntime is
	#    bundle-relative ("daemon"), resolved by Daemon.spawn against the launcher's MacOS
	#    dir, so the app stays relocatable.
	plist="$app/Contents/Info.plist"
	/usr/libexec/PlistBuddy -c "Add :DaemonRuntime string daemon" "$plist" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :DaemonArgs array" "$plist" 2>/dev/null || true
	codesign --force --deep --sign - "$app" 2>/dev/null || true
	echo "built $app (ship-daemon, self-contained bun exe, arm64)"
}

case "${1:-}" in
	--launcher) build_launcher ;;
	--ship-daemon) build_ship_daemon ;;
	"") echo "usage: build.sh [--release] <Name> | --launcher | --ship-daemon" >&2; exit 2 ;;
	*) build_booter "$1" ;;
esac
