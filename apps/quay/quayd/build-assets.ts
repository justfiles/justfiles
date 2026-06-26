// Ship-time builder for quayd's launcher web assets (NATIVE-LAUNCHER-PLAN
// §"Build cost: build at ship/install time, never at load"). esbuild bundles the
// React vendor family, the boot script, and the launcher chat surface ONCE here —
// the turbo `assets` task (a dependency of `build`), never on the user's machine at
// load. The emitted bytes land in `assets-dist/`; quayd serves them straight
// through (see assets.ts). This is our shipped code that never changes at runtime,
// so there is no reason to compile it (or disk-cache + version it) on first use.
//
// A mini-app's `gui.js` emits bare React specifiers (`react`, `react-dom/client`,
// `react/jsx-runtime`) and resolves them through the shell's importmap — one URL,
// one React instance per window. We get that singleton without the externalise
// dance: a single esbuild pass bundles the whole React family together (so React
// is included exactly once and every consumer shares it) and assigns it to a
// global; the per-specifier modules are thin shims that re-export off that global.
//
// The one legitimate build that stays at runtime is devkit's per-app gui
// (install-time, see devkit.ts) — not this.

import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
// The host SDK builder: `buildRuntime` bundles each SDK/valibot spec into a self-contained
// ESM module, emitted below as served `/vendor/<spec>.js` for the devkit runtime map (and
// the transitional SDK importmap). Build-time only — it imports native esbuild and reads
// node_modules, which the self-contained exe doesn't carry — so it never sits on the shipped
// exe's runtime path. The type overlay ships with app-code's installed sysroot.
import { buildRuntime } from '@justfiles/app/devkit-runtime'
// The bundler is runtime-selected (`#assets`): native esbuild under node, Bun.build
// under bun — so `bun quayd/build-assets.ts` builds these with zero esbuild. The React
// shim shape (a single core bundle + thin re-export shims) is identical either way.
import { bundleAsset } from '#assets'

const require = createRequire(import.meta.url)
// react/capnweb resolve from quay's node_modules, so esbuild bundles from here.
const RESOLVE_DIR = import.meta.dirname
// The launcher's chat entry (../launcher-ui/chat.tsx) — bundled like a gui.js
// (React externalised to the importmap) and served as /vendor/chat.js.
const CHAT_ENTRY = join(RESOLVE_DIR, '..', 'launcher-ui', 'chat.tsx')
// Where the built bytes land; assets.ts reads this dir at runtime (gitignored).
const OUT_DIR = join(RESOLVE_DIR, 'assets-dist')
// The agent's project docs at the repo root (the @justfiles/agent DOCS catalogue points
// at these). Copied whole into OUT_DIR/docs at ship time so the daemon carries them and
// reads them with no repo at runtime (docs.ts).
const DOCS_SRC = join(RESOLVE_DIR, '..', '..', '..', 'docs')

// Each shim file → the global slot it re-exports and the specifier whose export
// names it enumerates. The core bundle (below) fills `globalThis.__quayReact`.
const SHIMS: Record<string, { slot: string; specifier: string }> = {
	'react.js': { slot: 'react', specifier: 'react' },
	'react-dom.js': { slot: 'reactDom', specifier: 'react-dom' },
	'react-dom-client.js': { slot: 'reactDomClient', specifier: 'react-dom/client' },
	'jsx-runtime.js': { slot: 'jsxRuntime', specifier: 'react/jsx-runtime' },
	'jsx-dev-runtime.js': { slot: 'jsxDevRuntime', specifier: 'react/jsx-dev-runtime' }
}

async function main(): Promise<void> {
	const files = new Map<string, string>()
	files.set('core.js', await buildCore())
	for (const [file, { slot, specifier }] of Object.entries(SHIMS)) {
		files.set(file, shim(slot, specifier))
	}
	files.set('boot.js', await buildBoot())
	files.set('chat.js', await buildChat())

	await rm(OUT_DIR, { recursive: true, force: true })
	await mkdir(OUT_DIR, { recursive: true })
	for (const [name, text] of files) await writeFile(join(OUT_DIR, name), text)
	// The host SDK build, emitted as served `/vendor/<spec>.js` modules for the devkit runtime
	// map. Vendor URLs mirror the specifier, so nested `@justfiles/…` paths need their dirs
	// made. The type overlay ships with app-code's installed sysroot.
	const sdk = await emitSdkVendor(await buildRuntime())
	const docs = await copyDocs()
	console.log(
		`quayd: built ${files.size} launcher assets + ${sdk} SDK vendor + ${docs} docs → ${OUT_DIR}`
	)
}

// Each `buildRuntime` module written to `assets-dist/<spec>.js` (mirroring the specifier),
// which assets.ts serves at `/vendor/<spec>.js` and lists in the importmap.
async function emitSdkVendor(runtime: Record<string, string>): Promise<number> {
	for (const [spec, text] of Object.entries(runtime)) {
		const file = join(OUT_DIR, `${spec}.js`)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, text)
	}
	return Object.keys(runtime).length
}

// Ship docs/*.md beside the daemon (OUT_DIR/docs) so quayd reads them from disk at
// runtime without the repo. Flat copy of every .md; the agent's DOCS catalogue decides
// which it actually surfaces, so extra files here are harmless.
async function copyDocs(): Promise<number> {
	const out = join(OUT_DIR, 'docs')
	await mkdir(out, { recursive: true })
	const names = (await readdir(DOCS_SRC)).filter((name) => name.endsWith('.md'))
	await Promise.all(names.map((name) => copyFile(join(DOCS_SRC, name), join(out, name))))
	return names.length
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
		// Swallow the macOS WKWebView "no responder" beep (NSBeep) on Escape: a keydown
		// the page doesn't preventDefault reaches AppKit's cancelOperation:, which beeps.
		// Capture-phase + preventDefault kills the beep for every mini-app; propagation
		// still runs, so app-level Escape handlers (e.g. closing a palette) are unaffected.
		addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault() }, true)
		const cfg = window.__quay
		const root = document.getElementById('root')
		const berth = newWebSocketRpcSession(
			'ws://' + location.host + '/berth?app=' + encodeURIComponent(cfg.id) + '&token=' + encodeURIComponent(cfg.token)
		)
		;(async () => {
			try {
				// Overlap the gui.js module fetch+parse (which pulls in React/core)
				// with the state round-trip rather than awaiting them in series.
				const [mod, state] = await Promise.all([
					import('/app/' + encodeURIComponent(cfg.id) + '/gui.js'),
					berth.state()
				])
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

// The launcher's chat surface (`launcher-ui/chat.tsx`): the shared React Transcript
// over quay's privileged ws. Bundled exactly like a mini-app gui.js — React (and the
// jsx runtime) externalised to the importmap so it shares the one vendored React,
// keeping this bundle tiny.
async function buildChat(): Promise<string> {
	return bundleAsset({
		entry: CHAT_ENTRY,
		resolveDir: RESOLVE_DIR,
		jsx: true,
		external: [
			'react',
			'react-dom',
			'react-dom/client',
			'react/jsx-runtime',
			'react/jsx-dev-runtime'
		]
	})
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

// Production React: a quay app is an installed, shipping app, not a dev session — the
// prod build is markedly smaller and parses/renders faster in the cold WebContent
// process each launch spins up, which is the dominant cost of first paint. (NODE_ENV
// production is set by the bundler seam.)
function bundle(contents: string): Promise<string> {
	return bundleAsset({ contents, resolveDir: RESOLVE_DIR })
}

await main()
