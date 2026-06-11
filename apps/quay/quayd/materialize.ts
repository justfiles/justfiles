// Slice 6: project the kernel catalog into the OS. For each app the kernel lists,
// quayd materialises a thin `.app` into ~/Applications/Quay Apps/ — the shared
// booter binary + a per-app Info.plist + a generated icon, and *no app code* (the
// bytes stay in the Volume; quayd serves them over http from Slice 7). The bundle
// is ad-hoc signed (`codesign -s -`, locally created ⟹ no quarantine ⟹
// Gatekeeper-clean) and registered with `lsregister` so Spotlight/Launchpad/Raycast
// find it. The reconcile is strictly one-way (Volume → OS): install → write,
// uninstall → remove, change → refresh — the Volume always wins, so there is no
// two-store coherence problem.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// What the projection needs from a kernel manifest (structurally a subset of it).
export interface ProjectionApp {
	id: string
	name: string
	version?: string
}

const APPS_DIR = join(homedir(), 'Applications', 'Quay Apps')
// The shared booter binary + icon tool, emitted by native/build.sh. Both are dev
// artifacts here (Command Line Tools only); a packaged quay would ship them inside
// Quay.app instead.
const BUILD_DIR = join(import.meta.dirname, '..', 'native', 'build')
const BOOTER = join(BUILD_DIR, 'quay-shell')
const MAKEICON = join(BUILD_DIR, 'quay-makeicon')
// How a Spotlight-launched booter ensure-runs quayd (mirrors the launcher's
// QuaydNode/QuaydScript): this machine's node + the quayd entrypoint, run through
// the tsx loader. Dev wiring — a packaged quay would ship the daemon instead.
const QUAYD_NODE = process.execPath
const QUAYD_SCRIPT = join(import.meta.dirname, 'main.ts')
const LSREGISTER =
	'/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

// Reconcile ~/Applications/Quay Apps/ to exactly the kernel's catalog. Idempotent:
// each bundle carries a signature marker, so an unchanged app is skipped (no
// re-sign/re-register churn on every boot).
export async function reconcileProjection(apps: ProjectionApp[]): Promise<void> {
	if (!existsSync(BOOTER)) {
		console.warn(
			`quayd: booter missing (${BOOTER}); skipping .app projection — run native/build.sh`
		)
		return
	}
	await mkdir(APPS_DIR, { recursive: true })
	const booterMtime = statSync(BOOTER).mtimeMs
	const desired = new Map(apps.map((app) => [`${exec(app.name)}.app`, app]))

	// Remove bundles the kernel no longer lists (uninstall / sync-out). The Volume
	// wins — a stray bundle is never promoted back into the catalog.
	for (const entry of await readdir(APPS_DIR).catch(() => [])) {
		if (entry.endsWith('.app') && !desired.has(entry)) await remove(join(APPS_DIR, entry))
	}

	// Write or refresh each desired bundle whose signature changed.
	for (const [dir, app] of desired) {
		const path = join(APPS_DIR, dir)
		const sig = signature(app, booterMtime)
		if (readSig(path) === sig) continue
		await writeBundle(path, app, sig)
		await run('codesign', ['--force', '--sign', '-', path])
		await run(LSREGISTER, ['-f', path])
	}
}

async function writeBundle(path: string, app: ProjectionApp, sig: string): Promise<void> {
	await rm(path, { recursive: true, force: true })
	const macos = join(path, 'Contents', 'MacOS')
	const res = join(path, 'Contents', 'Resources')
	await mkdir(macos, { recursive: true })
	await mkdir(res, { recursive: true })
	const bin = exec(app.name)
	await copyFile(BOOTER, join(macos, bin))
	await chmod(join(macos, bin), 0o755)
	await writeFile(join(path, 'Contents', 'Info.plist'), plist(app, bin))
	await makeIcon(res, app.name)
	await writeFile(join(res, '.quay'), sig)
}

// Drop the bundle and unregister it so it leaves Spotlight/Launchpad promptly.
async function remove(path: string): Promise<void> {
	await run(LSREGISTER, ['-u', path])
	await rm(path, { recursive: true, force: true })
}

// A per-letter glyph icon, matching the launcher's tiles (real per-app SVG icons
// from the Volume are a later refinement). Best-effort: a missing tool or failure
// just leaves the bundle with the system default icon.
async function makeIcon(res: string, name: string): Promise<void> {
	if (!existsSync(MAKEICON)) return
	const letter = (name.charAt(0) || 'Q').toUpperCase()
	const tmp = await mkdtemp(join(tmpdir(), 'quay-icon-'))
	const set = join(tmp, 'AppIcon.iconset')
	await mkdir(set, { recursive: true })
	const ok = await run(MAKEICON, ['512', join(set, 'icon_512x512.png'), letter])
	await run(MAKEICON, ['1024', join(set, 'icon_512x512@2x.png'), letter])
	if (ok) await run('iconutil', ['-c', 'icns', set, '-o', join(res, 'AppIcon.icns')])
	await rm(tmp, { recursive: true, force: true })
}

// Bundle ids match the booter's launch path (Launcher.swift) and the Phase-0
// convention: `app.justfiles.quay.app.<id>`, QuayAppId tells the booter who it is.
function plist(app: ProjectionApp, bin: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>${app.name}</string>
	<key>CFBundleDisplayName</key><string>${app.name}</string>
	<key>CFBundleIdentifier</key><string>app.justfiles.quay.app.${app.id}</string>
	<key>CFBundleExecutable</key><string>${bin}</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleVersion</key><string>${app.version ?? '1'}</string>
	<key>CFBundleShortVersionString</key><string>${app.version ?? '1.0'}</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>QuayAppId</key><string>${app.id}</string>
	<key>QuaydNode</key><string>${QUAYD_NODE}</string>
	<key>QuaydScript</key><string>${QUAYD_SCRIPT}</string>
	<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`
}

// Identity of a materialised bundle: rebuild only when one of these changes (so a
// new booter binary refreshes every bundle; a rename/version bump refreshes one;
// a moved node/script path re-stamps the spawn wiring).
function signature(app: ProjectionApp, booterMtime: number): string {
	return JSON.stringify({
		id: app.id,
		name: app.name,
		version: app.version,
		booter: booterMtime,
		node: QUAYD_NODE,
		script: QUAYD_SCRIPT
	})
}

function readSig(path: string): string {
	try {
		return readFileSync(join(path, 'Contents', 'Resources', '.quay'), 'utf8')
	} catch {
		return ''
	}
}

// Filesystem-safe executable + bundle-dir name from the display name.
function exec(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, '') || 'App'
}

// Best-effort spawn (true on exit 0). codesign/lsregister failures are tolerated —
// locally created bundles run unsigned, and Spotlight re-indexes on its own.
function run(cmd: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => execFile(cmd, args, (err) => resolve(!err)))
}
