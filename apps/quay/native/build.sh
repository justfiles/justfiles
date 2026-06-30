#!/bin/sh
# Build the quay native shell — one binary, two modes (booter + launcher).
# Command Line Tools only (no full Xcode): SwiftPM compiles, this script bundles.
#
#   ./build.sh Code          # a booter bundle ./Code.app (mock target, own identity)
#   ./build.sh --launcher    # dev launcher ./Quay.app — spawns quayd from source
#   ./build.sh --ship        # prod ./Quay.app — self-contained quayd exe + bundled assets
#   ./build.sh --ship-daemon # prod ./Quay.app — self-contained NEW daemon exe + Vite client
#   ./build.sh --release …   # optimise the binaries for shipping (default: debug)
#   ./build.sh --runtime bun … # stamp the dev launcher to spawn quayd under bun (default: node)
#
# Both --launcher and --ship build the web assets (quayd/build-assets.ts) as part of the
# build — there is no separate `assets` step. The pnpm scripts (dev/build) build quay's
# workspace app deps via turbo first; this script only does the native shell + assets.
#
# `swift build` (Package.swift) discovers the Swift sources under Sources/ and
# produces two binaries — quay-shell (the shared booter+launcher) and quay-makeicon.
# We copy both into ./build/, a stable, gitignored handoff dir where quayd finds
# them to materialise the per-app `.app` bundles (Slice 6, see quayd/materialize.ts).
#
# --runtime is the reversibility hinge: it picks which runtime the launcher stamps
# into Info.plist for spawning quayd (Quayd.spawn() execs it verbatim). node is the
# default (the escape hatch); bun is the migration target. No Swift edits either way.
set -e
cd "$(dirname "$0")"

CONFIG=debug
RUNTIME=node
# Consume leading option flags (--release, --runtime X); leave the positional
# (Name | --launcher | --all) in "$1" for the dispatch case at the bottom.
while :; do
	case "${1:-}" in
		-r | --release) CONFIG=release; shift ;;
		--runtime) RUNTIME="$2"; shift 2 ;;
		*) break ;;
	esac
done
case "$RUNTIME" in node | bun) ;; *) echo "build.sh: --runtime must be node|bun" >&2; exit 2 ;; esac

BUILD="$(pwd)/build"
mkdir -p "$BUILD"
BIN="$BUILD/quay-shell"
ICON="$BUILD/quay-makeicon"

# Compile once via SwiftPM (incremental — only changed sources recompile), then
# publish the two binaries into ./build/. The launcher's UserNotifications link
# lives in Package.swift now.
swift build -c "$CONFIG"
bin="$(swift build -c "$CONFIG" --show-bin-path)"
cp "$bin/quay-shell" "$BIN"
cp "$bin/quay-makeicon" "$ICON" 2>/dev/null || ICON=""

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

# Stamp the generic spawn keys into the launcher plist for the selected --runtime.
# QuaydRuntime is the executable, QuaydArgs the args before the script, QuaydScript
# the entrypoint. node needs the rawLoader (?raw md) + tsx loaders; bun runs both
# TS and ?raw natively, so its args are empty.
stamp_quayd() { # plist
	plist="$1"
	quayd="$(cd ../quayd && pwd)"
	/usr/libexec/PlistBuddy -c "Add :QuaydScript string $quayd/main.ts" "$plist" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :QuaydArgs array" "$plist" 2>/dev/null || true
	if [ "$RUNTIME" = bun ]; then
		/usr/libexec/PlistBuddy -c "Add :QuaydRuntime string $(command -v bun)" "$plist" 2>/dev/null || true
	else
		/usr/libexec/PlistBuddy -c "Add :QuaydRuntime string $(command -v node)" "$plist" 2>/dev/null || true
		for arg in "--import" "$quayd/rawLoader.mjs" "--import" "tsx"; do
			/usr/libexec/PlistBuddy -c "Add :QuaydArgs: string $arg" "$plist" 2>/dev/null || true
		done
	fi
}

build_launcher() {
	app="Quay.app"
	make_bundle "$app" "Quay" "app.justfiles.quay" "" "1"
	# The launcher web assets land in quayd/assets-dist, where the dev daemon reads them
	# (resources.ts). Built with node/esbuild so the dev path needs no bun.
	(cd .. && node --import tsx quayd/build-assets.ts)
	# Dev wiring: how the launcher spawns quayd from source (Command Line Tools have no
	# packaged daemon). Stamp generic runtime keys; Quayd.spawn() execs them verbatim, so
	# the node-vs-bun choice lives here, not in Swift (the reversibility hinge).
	stamp_quayd "$app/Contents/Info.plist"
	codesign --force --sign - "$app" 2>/dev/null || true # re-sign after adding assets
	echo "built $app (launcher, runtime=$RUNTIME)"
}

build_booter() { # Name
	name="$1"
	id="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
	app="$name.app"
	make_bundle "$app" "$name" "app.justfiles.quay.app.$id" "$id" ""
	echo "built $app (booter, id=$id)"
}

copy_builtin() { # resources_dir app_id package_dir
	dst="$1/builtins/$2"
	src="../../../packages/$3/dist"
	[ -f "$src/manifest.json" ] || {
		echo "build.sh: missing $src/manifest.json (build workspace apps first)" >&2
		exit 1
	}
	rm -rf "$dst"
	mkdir -p "$dst"
	cp -R "$src/." "$dst/"
	rm -f "$dst/bundle.js" "$dst/bundle.d.ts"
}

copy_builtins() { # resources_dir
	copy_builtin "$1" app.code app-code
	copy_builtin "$1" app.frieren.files app-files
	copy_builtin "$1" app.justfiles.counter app-counter
	copy_builtin "$1" app.frieren.notes app-notes
	copy_builtin "$1" app.frieren.paint app-paint
	copy_builtin "$1" app.frieren.settings app-settings
}

# A self-contained, shippable Quay.app: the launcher binary + an embedded bun-compiled
# quayd exe (arm64) + every on-disk resource the daemon reads, flat under Resources/.
# No system node/bun, no tsx, no repo, no esbuild — resources.ts resolves these next to
# the exe (QUAY_SHIPPED). The node escape hatch is unaffected: this is build:bun, and a
# build:node target can sit beside it (deferred).
build_ship() {
	app="Quay.app"
	make_bundle "$app" "Quay" "app.justfiles.quay" "" "1"
	res="$app/Contents/Resources"
	exe="$(pwd)/$app/Contents/MacOS/quayd"

	# 1. The self-contained quayd exe (arm64) → Contents/MacOS/quayd.
	(cd .. && bun quayd/build-exe.ts --outfile "$exe" --target bun-darwin-arm64)
	# 2. Launcher assets (vendor/boot/chat bundles + agent docs) → Resources/assets-dist.
	#    Built with bun so the prod path is esbuild-free (the #assets seam picks Bun.build).
	(cd .. && bun quayd/build-assets.ts >/dev/null)
	mkdir -p "$res/assets-dist" && cp -R ../quayd/assets-dist/. "$res/assets-dist/"
	# 3. The shared booter binary + icon tool (materialize copies these per app) → Resources/build.
	mkdir -p "$res/build" && cp "$BIN" "$res/build/quay-shell"
	[ -n "$ICON" ] && cp "$ICON" "$res/build/quay-makeicon"
	# 4. @justfiles/design stylesheets quayd serves under /design → Resources/design.
	mkdir -p "$res/design"
	designdir="$(cd .. && node -e "console.log(require('path').dirname(require.resolve('@justfiles/design/mac.css')))")"
	cp "$designdir"/*.css "$res/design/"
	# 5. Built-in app bundle roots → Resources/builtins.
	copy_builtins "$res"
	# 6. Spawn the embedded exe verbatim — no runtime, no args, no script. QuaydRuntime is
	#    bundle-relative ("quayd"), resolved by Quayd.spawn against the launcher's MacOS dir,
	#    so the app stays relocatable.
	plist="$app/Contents/Info.plist"
	/usr/libexec/PlistBuddy -c "Add :QuaydRuntime string quayd" "$plist" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :QuaydArgs array" "$plist" 2>/dev/null || true
	codesign --force --deep --sign - "$app" 2>/dev/null || true
	echo "built $app (ship, self-contained bun exe, arm64)"
}

# A self-contained, shippable Quay.app backed by the NEW daemon (apps/quay/daemon): the
# launcher binary + an embedded bun-compiled daemon exe (arm64) + the on-disk resources the
# daemon reads, under Resources/. The daemon does zero frontend bundling: Vite builds the
# browser surfaces (launcher / chat / app shell + assets + `/vendor/*` React) into
# ui/dist/client, which rides on disk beside the exe as Resources/client; the builtin app
# roots ride alongside it. All are resolved via QUAY_SHIPPED.
build_ship_daemon() {
	app="Quay.app"
	make_bundle "$app" "Quay" "app.justfiles.quay" "" "1"
	res="$app/Contents/Resources"
	exe="$(pwd)/$app/Contents/MacOS/quay-daemon"

	# 1. The self-contained daemon exe (arm64) → Contents/MacOS/quay-daemon.
	(cd .. && bun daemon/build-exe.ts --outfile "$exe" --target bun-darwin-arm64)
	# 2. Browser surfaces (launcher / chat / app shell + hashed /assets/* + the shared React
	#    /vendor/* bundles) built by Vite into ui/dist/client → Resources/client, where the
	#    daemon's CLIENT_DIR resolves them when shipped. Rebuild first (a clean Vite build
	#    empties dist/client) so a stale or absent tree can never ship.
	(cd .. && pnpm run ui:build >/dev/null)
	mkdir -p "$res/client" && cp -R ../ui/dist/client/. "$res/client/"
	# 3. Built-in app bundle roots (the daemon seeds these into the Volume) → Resources/builtins.
	copy_builtins "$res"
	# 4. The shared booter binary + icon tool → Resources/build. materialize.ts copies the
	#    booter into each projected ~/Applications/Quay Apps/*.app; without it the daemon logs
	#    "booter missing" and skips projection entirely (resources.ts resolves BUILD_DIR here
	#    when shipped).
	mkdir -p "$res/build" && cp "$BIN" "$res/build/quay-shell"
	[ -n "$ICON" ] && cp "$ICON" "$res/build/quay-makeicon"
	# 5. Spawn the embedded exe verbatim — no runtime, no args, no script. QuaydRuntime is
	#    bundle-relative ("quay-daemon"), resolved by Quayd.spawn against the launcher's MacOS
	#    dir, so the app stays relocatable.
	plist="$app/Contents/Info.plist"
	/usr/libexec/PlistBuddy -c "Add :QuaydRuntime string quay-daemon" "$plist" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Add :QuaydArgs array" "$plist" 2>/dev/null || true
	codesign --force --deep --sign - "$app" 2>/dev/null || true
	echo "built $app (ship-daemon, self-contained bun exe, arm64)"
}

case "${1:-}" in
	--launcher) build_launcher ;;
	--ship) build_ship ;;
	--ship-daemon) build_ship_daemon ;;
	"") echo "usage: build.sh [--release] [--runtime node|bun] <Name> | --launcher | --ship | --ship-daemon" >&2; exit 2 ;;
	*) build_booter "$1" ;;
esac
