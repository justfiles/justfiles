#!/bin/sh
# Build the quay native shell — one binary, two modes (booter + launcher).
# Command Line Tools only (swiftc); no full Xcode.
#
#   ./build.sh Code        # a booter bundle ./Code.app (mock target, own identity)
#   ./build.sh --launcher  # the launcher  ./Quay.app  (LSUIElement + hotkey panel)
#
# The shared booter + icon tool land in ./build/ — a stable, gitignored dir where
# quayd finds them to materialise the per-app `.app` bundles (Slice 6). The mock
# mini-app `.app`s this used to stamp are now kernel-driven (see quayd/materialize).
set -e
cd "$(dirname "$0")"

BUILD="$(pwd)/build"
mkdir -p "$BUILD"
BIN="$BUILD/quay-shell"
ICON="$BUILD/quay-makeicon"

# Shared binary + icon tool, built once.
swiftc -O -swift-version 5 main.swift Booter.swift Launcher.swift -o "$BIN"
swiftc -O -swift-version 5 makeicon.swift -o "$ICON" 2>/dev/null || ICON=""

emit_plist() { # name bundle_id [quay_id] [lsui]
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
	[ -n "$3" ] && printf '\t<key>QuayAppId</key><string>%s</string>\n' "$3"
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

make_bundle() { # app_path name bundle_id [quay_id] [lsui]
	app="$1"
	rm -rf "$app"
	mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
	cp "$BIN" "$app/Contents/MacOS/$2"
	emit_plist "$2" "$3" "$4" "$5" >"$app/Contents/Info.plist"
	make_icon "$app" "$(printf '%s' "$2" | cut -c1)"
	codesign --force --sign - "$app" 2>/dev/null || true
}

build_launcher() {
	app="Quay.app"
	make_bundle "$app" "Quay" "app.justfiles.quay" "" "1"
	cp -R ../launcher-ui "$app/Contents/Resources/launcher-ui"
	# Dev wiring: how the launcher spawns quayd (Command Line Tools have no packaged
	# daemon yet). Stamp this machine's absolute node + quayd entrypoint paths.
	plist="$app/Contents/Info.plist"
	/usr/libexec/PlistBuddy -c "Add :QuaydNode string $(command -v node)" "$plist" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :QuaydScript string $(cd ../quayd && pwd)/main.ts" "$plist" 2>/dev/null || true
	codesign --force --sign - "$app" 2>/dev/null || true # re-sign after adding assets
	echo "built $app (launcher)"
}

build_booter() { # Name
	name="$1"
	id="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
	app="$name.app"
	make_bundle "$app" "$name" "app.justfiles.quay.app.$id" "$id" ""
	echo "built $app (booter, id=$id)"
}

case "${1:-}" in
	--launcher | --all) build_launcher ;;
	"") echo "usage: build.sh <Name> | --launcher" >&2; exit 2 ;;
	*) build_booter "$1" ;;
esac
