// Project the kernel catalog into the OS. For each app the kernel lists, the daemon
// materialises a thin `.app` into ~/Applications/Spud Apps/ — the shared booter binary
// + a per-app Info.plist + a generated icon, and *no app code* (the bytes stay in the
// Volume; the daemon serves them over http). The bundle is ad-hoc signed (`codesign -s
// -`, locally created ⟹ no quarantine ⟹ Gatekeeper-clean) and registered with
// `lsregister` so Spotlight/Launchpad/Raycast find it. The reconcile is strictly one-way
// (Volume → OS): install → write, uninstall → remove, change → refresh — the Volume
// always wins, so there is no two-store coherence problem.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SHIPPED } from './resources'

// What the projection needs from a kernel manifest (structurally a subset of it).
export interface ProjectionApp {
	id: string
	name: string
	version?: string
	iconPath?: string
	iconBytes?: Uint8Array
}

const APPS_DIR = join(homedir(), 'Applications', 'Spud Apps')
// The shared booter binary + icon tool that materialize stamps into each .app. Dev reads
// the SwiftPM build output (native/build); shipped reads the copies build.sh drops beside
// the exe (Spud.app/Contents/Resources/build).
const BUILD_DIR = SHIPPED
	? join(dirname(process.execPath), '..', 'Resources', 'build')
	: join(import.meta.dirname, '..', 'native', 'build')
const BOOTER = join(BUILD_DIR, 'shell')
const MAKEICON = join(BUILD_DIR, 'makeicon')
const LSREGISTER =
	'/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

// How a cold-launched .app respawns the daemon: when no daemon is running, the booter
// (shell) reads these from the projected bundle's OWN plist (Daemon.ensure → spawn
// in Launcher.swift) and execs them, so the bundle spawns the daemon exactly as it runs
// now. The runtime path must be ABSOLUTE — a projected bundle under ~/Applications/Spud
// Apps holds only the booter, so the keys point back at the real daemon. Shipped:
// process.execPath is Spud.app/Contents/MacOS/daemon, run verbatim (no script). Dev:
// the current bun on daemon/main.ts. Bun runs TS natively, so there are never any args.
const DAEMON_RUNTIME = process.execPath
const DAEMON_SCRIPT = SHIPPED ? '' : join(import.meta.dirname, 'main.ts')

// Reconcile ~/Applications/Spud Apps/ to exactly the kernel's catalog. Idempotent:
// each bundle carries a signature marker, so an unchanged app is skipped (no
// re-sign/re-register churn on every boot).
export async function reconcileProjection(apps: ProjectionApp[]): Promise<void> {
	if (!existsSync(BOOTER)) {
		console.warn(
			`spud daemon: booter missing (${BOOTER}); skipping .app projection — run native/build.sh`
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
		const sig = projectionSignature(app, booterMtime)
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
	await makeIcon(res, app)
	await writeFile(join(res, '.sig'), sig)
}

// Drop the bundle and unregister it so it leaves Spotlight/Launchpad promptly.
async function remove(path: string): Promise<void> {
	await run(LSREGISTER, ['-u', path])
	await rm(path, { recursive: true, force: true })
}

// Use the bundle's own icon when present; otherwise draw the legacy glyph icon.
// Best-effort: a missing tool or failure just leaves the bundle with the system
// default icon.
async function makeIcon(res: string, app: ProjectionApp): Promise<void> {
	if (!existsSync(MAKEICON)) return
	const letter = (app.name.charAt(0) || 'Q').toUpperCase()
	const tmp = await mkdtemp(join(tmpdir(), 'icon-'))
	try {
		const set = join(tmp, 'AppIcon.iconset')
		await mkdir(set, { recursive: true })
		const source = await writeIconSource(tmp, app)
		let ok = source ? await renderIconset(set, letter, source) : false
		if (!ok) ok = await renderIconset(set, letter)
		if (ok) await run('iconutil', ['-c', 'icns', set, '-o', join(res, 'AppIcon.icns')])
	} finally {
		await rm(tmp, { recursive: true, force: true })
	}
}

async function writeIconSource(tmp: string, app: ProjectionApp): Promise<string | undefined> {
	const source = iconSource(app)
	if (!source) return undefined
	const path = join(tmp, `source${source.ext}`)
	await writeFile(path, source.bytes)
	return path
}

function iconSource(app: ProjectionApp): { ext: string; bytes: Uint8Array } | undefined {
	const bytes = app.iconBytes
	if (!bytes?.byteLength) return undefined
	const text = new TextDecoder().decode(bytes).trim()
	if (text.startsWith('data:image/')) return dataUrlImage(text)
	return { ext: iconExt(app.iconPath, bytes), bytes }
}

function dataUrlImage(text: string): { ext: string; bytes: Uint8Array } | undefined {
	try {
		const comma = text.indexOf(',')
		if (comma < 0) return undefined
		const meta = text.slice(0, comma)
		const body = text.slice(comma + 1)
		const bytes = meta.includes(';base64')
			? Buffer.from(body, 'base64')
			: new TextEncoder().encode(decodeURIComponent(body))
		return bytes.byteLength ? { ext: extFromMime(meta), bytes } : undefined
	} catch {
		return undefined
	}
}

function extFromMime(meta: string): string {
	if (meta.includes('image/png')) return '.png'
	if (meta.includes('image/jpeg')) return '.jpg'
	if (meta.includes('image/svg+xml')) return '.svg'
	return '.img'
}

function iconExt(path = '', bytes: Uint8Array): string {
	const p = path.toLowerCase()
	if (p.endsWith('.png') || (bytes[0] === 0x89 && bytes[1] === 0x50)) return '.png'
	if (p.endsWith('.jpg') || p.endsWith('.jpeg') || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
		return '.jpg'
	}
	if (p.endsWith('.svg') || new TextDecoder().decode(bytes.slice(0, 128)).includes('<svg')) {
		return '.svg'
	}
	return '.img'
}

const MACOS_ICONSET: [size: number, file: string][] = [
	[16, 'icon_16x16.png'],
	[32, 'icon_16x16@2x.png'],
	[32, 'icon_32x32.png'],
	[64, 'icon_32x32@2x.png'],
	[128, 'icon_128x128.png'],
	[256, 'icon_128x128@2x.png'],
	[256, 'icon_256x256.png'],
	[512, 'icon_256x256@2x.png'],
	[512, 'icon_512x512.png'],
	[1024, 'icon_512x512@2x.png']
]

async function renderIconset(set: string, letter: string, source?: string): Promise<boolean> {
	const image = source ? [source] : []
	let ok = true
	for (const [size, file] of MACOS_ICONSET) {
		ok = (await run(MAKEICON, [String(size), join(set, file), letter, ...image])) && ok
	}
	return ok
}

// Bundle ids match the booter's launch path (Launcher.swift) and the Phase-0
// convention: `app.justfiles.spud.app.<id>`, AppId tells the booter who it is.
function plist(app: ProjectionApp, bin: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>${app.name}</string>
	<key>CFBundleDisplayName</key><string>${app.name}</string>
	<key>CFBundleIdentifier</key><string>app.justfiles.spud.app.${app.id}</string>
	<key>CFBundleExecutable</key><string>${bin}</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleVersion</key><string>${app.version ?? '1'}</string>
	<key>CFBundleShortVersionString</key><string>${app.version ?? '1.0'}</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>AppId</key><string>${app.id}</string>
	<key>DaemonRuntime</key><string>${DAEMON_RUNTIME}</string>
	<key>DaemonArgs</key><array/>
	<key>DaemonScript</key><string>${DAEMON_SCRIPT}</string>
	<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`
}

// Identity of a materialised bundle: rebuild only when one of these changes (so a
// new booter binary refreshes every bundle; a rename/version bump refreshes one;
// a moved runtime/script path re-stamps the spawn wiring).
export function projectionSignature(app: ProjectionApp, booterMtime: number): string {
	return JSON.stringify({
		id: app.id,
		name: app.name,
		version: app.version,
		icon: iconSignature(app),
		iconFormat: MACOS_ICONSET.map(([size, file]) => `${size}:${file}`),
		booter: booterMtime,
		runtime: DAEMON_RUNTIME,
		script: DAEMON_SCRIPT
	})
}

function iconSignature(app: ProjectionApp): { path?: string; hash: string } | undefined {
	if (!app.iconBytes) return undefined
	return { path: app.iconPath, hash: createHash('sha256').update(app.iconBytes).digest('hex') }
}

function readSig(path: string): string {
	try {
		return readFileSync(join(path, 'Contents', 'Resources', '.sig'), 'utf8')
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
