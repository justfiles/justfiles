// The browser-facing assets quayd serves over localhost http (Slice 7): the
// shared-React vendor modules, the boot script, and the per-app HTML shell.
//
// A mini-app's `gui.js` emits bare React specifiers (`react`, `react-dom/client`,
// `react/jsx-runtime`) and resolves them through the shell's importmap — one URL,
// one React instance per window. We get that singleton without the externalise
// dance: a single esbuild pass bundles the whole React family together (so React
// is included exactly once and every consumer shares it) and assigns it to a
// global; the per-specifier modules are thin shims that re-export off that global.
// `boot.js` is a separate bundle (Cap'n Web inlined) that opens the berth and
// mounts the GUI. All of it is built once, memoised, and cached to disk by React
// version so a daemon restart is instant.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
// react/capnweb resolve from quay's node_modules, so esbuild bundles from here.
const RESOLVE_DIR = import.meta.dirname
const CACHE_DIR = join(homedir(), 'Library', 'Application Support', 'quay', 'cache', 'vendor')

// Bump when the bundling logic here changes; the React version is folded in too,
// so a `pnpm update react` invalidates the cache automatically.
const REV = 1

// Each shim file → the global slot it re-exports and the specifier whose export
// names it enumerates. The core bundle (below) fills `globalThis.__quayReact`.
const SHIMS: Record<string, { slot: string; specifier: string }> = {
	'react.js': { slot: 'react', specifier: 'react' },
	'react-dom.js': { slot: 'reactDom', specifier: 'react-dom' },
	'react-dom-client.js': { slot: 'reactDomClient', specifier: 'react-dom/client' },
	'jsx-runtime.js': { slot: 'jsxRuntime', specifier: 'react/jsx-runtime' },
	'jsx-dev-runtime.js': { slot: 'jsxDevRuntime', specifier: 'react/jsx-dev-runtime' }
}

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

// The vendor assets keyed by URL path (`/vendor/<file>`). Lazy + memoised: the
// launcher never needs React, so the (~0.5s) build is paid once, on first app open.
export function vendorAssets(): Promise<Map<string, Uint8Array>> {
	cache ??= loadOrBuild()
	return cache
}

// The HTML shell the booter loads. It carries the importmap, the {id, token} the
// boot script needs to open its berth, and nothing else — no app logic, no assets.
export function shellHtml(id: string, token: string): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${id.replace(/[<&]/g, '')}</title>
<script type="importmap">${IMPORTMAP}</script>
<style>html,body,#root{height:100%;margin:0}body{font:14px -apple-system,system-ui,sans-serif}</style>
</head>
<body>
<div id="root"></div>
<script>window.__quay=${JSON.stringify({ id, token })}</script>
<script type="module" src="/vendor/boot.js"></script>
</body>
</html>
`
}

async function loadOrBuild(): Promise<Map<string, Uint8Array>> {
	const key = cacheKey()
	const cached = await readCache(key)
	if (cached) return cached
	const built = await buildAll()
	await writeCache(key, built).catch(() => {}) // a read-only cache dir is non-fatal
	return built
}

async function buildAll(): Promise<Map<string, Uint8Array>> {
	const out = new Map<string, Uint8Array>()
	const bytes = (text: string) => new TextEncoder().encode(text)
	out.set('/vendor/core.js', bytes(await buildCore()))
	for (const [file, { slot, specifier }] of Object.entries(SHIMS)) {
		out.set(`/vendor/${file}`, bytes(shim(slot, specifier)))
	}
	out.set('/vendor/boot.js', bytes(await buildBoot()))
	return out
}

// One pass over the whole React family: React is bundled once and shared, then the
// family is parked on a global the shims read.
async function buildCore(): Promise<string> {
	return bundle(`
		import react from 'react'
		import reactDom from 'react-dom'
		import reactDomClient from 'react-dom/client'
		import jsxRuntime from 'react/jsx-runtime'
		import jsxDevRuntime from 'react/jsx-dev-runtime'
		globalThis.__quayReact = { react, reactDom, reactDomClient, jsxRuntime, jsxDevRuntime }
	`)
}

// Cap'n Web inlined; opens a token-scoped berth, imports the app's gui.js, and
// mounts it with a transport whose invoke/subscribe forward to the berth.
async function buildBoot(): Promise<string> {
	return bundle(`
		import { newWebSocketRpcSession } from 'capnweb'
		const cfg = window.__quay
		const root = document.getElementById('root')
		const berth = newWebSocketRpcSession(
			'ws://' + location.host + '/berth?app=' + encodeURIComponent(cfg.id) + '&token=' + encodeURIComponent(cfg.token)
		)
		;(async () => {
			try {
				const mod = await import('/app/' + encodeURIComponent(cfg.id) + '/gui.js')
				const state = await berth.state()
				mod.gui.mount(root, state, {
					transport: {
						invoke: (message) => berth.dispatch(message),
						subscribe: (onState) => {
							const unsub = berth.subscribe(onState)
							return () => Promise.resolve(unsub).then((u) => u && u()).catch(() => {})
						}
					}
				})
			} catch (error) {
				root.textContent = 'quay: ' + error
			}
		})()
	`)
}

// A shim re-exports its slot off the global the core bundle fills. Importing
// `./core.js` first guarantees the global is set before the shim's body reads it.
// `default` is the React object; named exports are its own keys (enumerated here
// at build time, since a runtime value can't synthesise ESM named bindings).
function shim(slot: string, specifier: string): string {
	const mod = require(specifier) as Record<string, unknown>
	const names = Object.keys(mod).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n))
	const decls = names.map((n) => `${n} = m.${n}`).join(', ')
	return (
		`import './core.js'\nconst m = globalThis.__quayReact.${slot}\nexport default m\n` +
		(decls ? `export const ${decls}\n` : '')
	)
}

async function bundle(contents: string): Promise<string> {
	const result = await build({
		stdin: { contents, resolveDir: RESOLVE_DIR, loader: 'js' },
		bundle: true,
		write: false,
		format: 'esm',
		minify: true,
		// Development React (dev warnings + a working jsx-dev-runtime), matching
		// frieren; the size cost is irrelevant over localhost.
		define: { 'process.env.NODE_ENV': '"development"' },
		logLevel: 'silent'
	})
	const text = result.outputFiles[0]?.text
	if (!text) throw new Error('quayd: vendor bundle produced no output')
	return text
}

function cacheKey(): string {
	const version = (require('react') as { version?: string }).version ?? '0'
	return `react@${version}|rev=${REV}`
}

async function readCache(key: string): Promise<Map<string, Uint8Array> | undefined> {
	try {
		if ((await readFile(join(CACHE_DIR, '.key'), 'utf8')) !== key) return undefined
		const out = new Map<string, Uint8Array>()
		for (const file of ['core.js', ...Object.keys(SHIMS), 'boot.js']) {
			out.set(`/vendor/${file}`, await readFile(join(CACHE_DIR, file)))
		}
		return out
	} catch {
		return undefined
	}
}

async function writeCache(key: string, assets: Map<string, Uint8Array>): Promise<void> {
	await mkdir(CACHE_DIR, { recursive: true })
	for (const [url, bytes] of assets)
		await writeFile(join(CACHE_DIR, url.slice('/vendor/'.length)), bytes)
	await writeFile(join(CACHE_DIR, '.key'), key)
}
