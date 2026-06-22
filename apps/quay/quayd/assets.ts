// The browser-facing assets quayd serves over localhost http (Slice 7): the
// shared-React vendor modules, the boot script, the launcher chat bundle, and the
// per-app HTML shell.
//
// The vendor + chat bundles are NOT built here — they are compiled once at ship
// time by `build-assets.ts` (the turbo `assets` task, a dependency of `build`) and
// emitted to `assets-dist/`; quayd just reads those static bytes and serves them.
// This is our shipped code that never changes at runtime, so it must never sit on
// the critical path of a window's first paint (NATIVE-LAUNCHER-PLAN §"Build cost").
// The per-app `gui.js` is the other static case — built at install time by devkit.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sdkExternals, vendorUrl } from '@justfiles/app/sdk-externals'
// Where build-assets.ts emits the vendor + chat bundles, and where the design styles
// live — resolved for dev vs. a shipped Quay.app by the one resource seam.
import { ASSETS_DIR, designPath } from './resources.ts'

const IMPORTMAP = JSON.stringify({
	imports: {
		react: '/vendor/react.js',
		'react-dom': '/vendor/react-dom.js',
		'react-dom/client': '/vendor/react-dom-client.js',
		'react/jsx-runtime': '/vendor/jsx-runtime.js',
		'react/jsx-dev-runtime': '/vendor/jsx-dev-runtime.js',
		// The SDK half is generated from the shared externals constant (URLs mirror the
		// specifier), so a new capability resolves with no manual edit here. React keeps its
		// existing mangled vendor names above.
		...Object.fromEntries(sdkExternals.map(({ spec }) => [spec, vendorUrl(spec)]))
	}
})

let cache: Promise<Map<string, Uint8Array>> | undefined
let sdkCache: Promise<Map<string, string>> | undefined

// The vendor assets keyed by URL path (`/vendor/<file>`). Read once from the
// ship-time build output and memoised for the daemon's life — no compile, no disk
// cache, no version key. A missing dir means the build step hasn't run.
export function vendorAssets(): Promise<Map<string, Uint8Array>> {
	cache ??= readAssets()
	return cache
}

// The host's in-memory SDK vendor sources keyed by SPEC (not URL) — the reducer-
// injection half of the SDK link model. Reuses the same `vendorAssets()` bytes the
// http server serves (no new cache/staging), decoded to source text; nodeSandbox
// wraps each as a data:/blob: module URL to resolve a reducer's `justfiles-sdk:`
// sentinels at spawn. Loaded lazily — only an SDK-importing reducer triggers it.
export function sdkSources(): Promise<Map<string, string>> {
	sdkCache ??= readSdkSources()
	return sdkCache
}

async function readSdkSources(): Promise<Map<string, string>> {
	const vendor = await vendorAssets()
	const out = new Map<string, string>()
	for (const { spec } of sdkExternals) {
		const bytes = vendor.get(vendorUrl(spec))
		if (bytes) out.set(spec, new TextDecoder().decode(bytes))
	}
	return out
}

async function readAssets(): Promise<Map<string, Uint8Array>> {
	const out = new Map<string, Uint8Array>()
	// Recursive walk so nested SDK vendor modules (`/vendor/@justfiles/….js`) serve too;
	// the URL key mirrors the path under assets-dist. React's flat names come along free.
	const walk = async (dir: string, prefix: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name
			const abs = join(dir, entry.name)
			if (entry.isDirectory()) await walk(abs, rel)
			else if (entry.name.endsWith('.js')) out.set(`/vendor/${rel}`, await readFile(abs))
		}
	}
	try {
		await walk(ASSETS_DIR, '')
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT')
			throw new Error(
				`quayd: launcher assets missing at ${ASSETS_DIR} — run \`pnpm --filter @justfiles/quay assets\` (or \`build\`/\`restart\`) to build them.`
			)
		throw err
	}
	return out
}

// The platform style quayd serves under `/design/`: `mac.css` (the native control
// look) plus the `design.css` it `@import`s (the `ds-*` shell components + tokens).
// frieren bundles these into its host page; here each app is its own webview, so
// quayd serves them standalone and the shell links the platform sheet. The export
// map is the allowlist — an unexported name fails to resolve and 404s. Read once.
const styles = new Map<string, Promise<Uint8Array>>()

export function designAsset(name: string): Promise<Uint8Array> {
	let bytes = styles.get(name)
	if (!bytes) {
		bytes = readFile(designPath(name))
		styles.set(name, bytes)
	}
	return bytes
}

// The HTML shell the booter loads. It carries the importmap, the platform stylesheet,
// the {id, token} the boot script needs to open its berth, and nothing else — no app
// logic, no assets.
export function shellHtml(id: string, token: string, usesReact: boolean): string {
	// Preload the React core up front *only for apps that import it* — otherwise boot.js
	// discovers it four imports deep (boot → gui → react shim → core), serialising the
	// slowest parse to the end of the launch waterfall. A pure-DOM app (e.g. counter)
	// imports no React, so it must NOT pay to fetch+parse the ~190 KB bundle it never uses.
	const reactPreload = usesReact ? '\n<link rel="modulepreload" href="/vendor/core.js">' : ''
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${id.replace(/[<&]/g, '')}</title>
<script type="importmap">${IMPORTMAP}</script>
<link rel="stylesheet" href="/design/mac.css">
<link rel="modulepreload" href="/vendor/boot.js">${reactPreload}
</head>
<body>
<div id="root"></div>
<script>window.__quay=${JSON.stringify({ id, token })}</script>
<script type="module" src="/vendor/boot.js"></script>
</body>
</html>
`
}

// The launcher chat shell quayd serves at `/launcher/chat`. Same shape as the mini-app
// shell (importmap + platform stylesheet), but it mounts the pre-built chat bundle
// directly (no boot.js / gui.js indirection) and always uses React, so it preloads the
// core. The transcript paints no background: in the app it sits in a transparent
// WKWebView over the launcher's native vibrancy, and mac.css's `:where()` defaults would
// otherwise fill it with `--window-bg` — the plain selector below (specificity > 0)
// overrides them.
export function launcherChatHtml(token: string): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Quay Chat</title>
<script type="importmap">${IMPORTMAP}</script>
<link rel="stylesheet" href="/design/mac.css">
<link rel="modulepreload" href="/vendor/core.js">
<link rel="modulepreload" href="/vendor/chat.js">
<style>html, body, #root { background: transparent; } #root { display: flex; flex-direction: column; }</style>
</head>
<body>
<div id="root"></div>
<script>window.__quayChat=${JSON.stringify({ token })}</script>
<script type="module" src="/vendor/chat.js"></script>
</body>
</html>
`
}
