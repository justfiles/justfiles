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
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
// Where build-assets.ts emits the vendor + chat bundles. Read at runtime, never built.
const ASSETS_DIR = join(import.meta.dirname, 'assets-dist')

const IMPORTMAP = JSON.stringify({
	imports: {
		react: '/vendor/react.js',
		'react-dom': '/vendor/react-dom.js',
		'react-dom/client': '/vendor/react-dom-client.js',
		'react/jsx-runtime': '/vendor/jsx-runtime.js',
		'react/jsx-dev-runtime': '/vendor/jsx-dev-runtime.js'
	}
})

let cache: Promise<Map<string, Uint8Array>> | undefined

// The vendor assets keyed by URL path (`/vendor/<file>`). Read once from the
// ship-time build output and memoised for the daemon's life — no compile, no disk
// cache, no version key. A missing dir means the build step hasn't run.
export function vendorAssets(): Promise<Map<string, Uint8Array>> {
	cache ??= readAssets()
	return cache
}

async function readAssets(): Promise<Map<string, Uint8Array>> {
	let files: string[]
	try {
		files = await readdir(ASSETS_DIR)
	} catch {
		throw new Error(
			`quayd: launcher assets missing at ${ASSETS_DIR} — run \`pnpm --filter @justfiles/quay assets\` (or \`build\`/\`restart\`) to build them.`
		)
	}
	const out = new Map<string, Uint8Array>()
	for (const file of files) {
		if (file.endsWith('.js')) out.set(`/vendor/${file}`, await readFile(join(ASSETS_DIR, file)))
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
		bytes = readFile(require.resolve(`@justfiles/design/${name}`))
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
<style>html, body, #root { background: transparent; }</style>
</head>
<body>
<div id="root"></div>
<script>window.__quayChat=${JSON.stringify({ token })}</script>
<script type="module" src="/vendor/chat.js"></script>
</body>
</html>
`
}
