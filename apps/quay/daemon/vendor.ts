// The browser-shared React layer. Each specifier below is bundled ONCE into a
// self-contained ESM module, served at `/vendor/<spec>.js`, and resolved through the
// page import map. So every app's `gui.js` links against a single shared React instance
// instead of bundling its own copy.
//
// Run `pnpm --filter @justfiles/quay vendor` to (re)generate `./vendor/*`. The
// output is a build artifact (gitignored); the daemon serves it (and inlines it
// under `bun build --compile`, like the CSS/HTML in main.ts).
//
// This file is BOTH the generator (run it) and the source of truth for the import
// map (`import { vendorImportMap } from './vendor'`), so the served modules and the
// map are generated from the same list and can never drift.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BunPlugin } from 'bun'

// ── The vendor allowlist ─────────────────────────────────────────────────────
// One entry per React subpath an app may import without bundling. The build
// externalizes every OTHER spec in this list (exact match), so cross-references
// (react-dom → react) collapse to the one shared module via the import map rather
// than a second inlined copy.
//
// Note on dev JSX: `react/jsx-dev-runtime` only has a real impl in React's
// DEVELOPMENT build. Apps are compiled with the production automatic runtime
// (`jsx`/`jsxs` from `react/jsx-runtime`), so it's intentionally omitted and MODE is
// 'production'. If you later serve dev/devkit-compiled apps, add it here and flip MODE.
export const vendorSpecs = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'] as const

// The URL a specifier is served at — mirrors the specifier verbatim, so the import-map
// value and the on-disk file path share one shape (`react-dom/client` →
// `/vendor/react-dom/client.js`).
export const vendorUrl = (spec: string): string => `/vendor/${spec}.js`

// The import map the shell HTML serves so the browser resolves each bare specifier to
// its single shared module. Built from `vendorSpecs`, the same list the codegen walks.
export const vendorImportMap = (): { imports: Record<string, string> } => ({
	imports: Object.fromEntries(vendorSpecs.map((spec) => [spec, vendorUrl(spec)]))
})

// ── Generator ────────────────────────────────────────────────────────────────

// React (and much of the npm ecosystem) ships as CJS with `NODE_ENV`-gated builds.
// 'production' strips dev warnings and is what shipped apps compile against.
const MODE = 'production'

const OUT_DIR = join(import.meta.dirname, 'vendor')

// The shell HTML (app/shell.html) is a hand-maintained source file with an empty
// import-map placeholder; daemon/htmlImportmap.ts injects `vendorImportMap()` at serve
// time, so the served modules and the map are still built from this one list and can
// never drift — this generator just emits the `/vendor/*` bundles below.

// A synthetic entry that re-exposes a package as clean ESM with EXPLICIT named
// exports — emitting `export const <name> = __ns[<name>]` for every name. We can't
// use the obvious `export * from spec`, because `Bun.build` does NOT carry a CJS
// module's named exports through to ESM output — it emits only `export default`, so a
// browser `import { createRoot } from 'react-dom/client'` throws "does not provide an
// export named 'createRoot'". That's an open Bun bug (oven-sh/bun#12463), and the
// per-name re-export below is the workaround the bug thread itself lands on. Note this
// is a *bundler* gap: Bun's (and Node's) RUNTIME interop resolves these names fine —
// which is exactly why `exportNames` can recover them by importing the package. esbuild
// has the same `export *`-from-CJS limitation, so switching bundlers wouldn't help.
// The namespace re-export hands back the default (a CJS module's `module.exports`) so
// `import X from "react"` keeps working too. Same shape for every spec.
const entrySource = (spec: string, names: readonly string[]): string =>
	`import * as __star from ${JSON.stringify(spec)}\n` +
	`const __ns = __star.default ?? __star\n` +
	`export default __ns\n` +
	names.map((n) => `export const ${n} = __ns[${JSON.stringify(n)}]\n`).join('')

// The export names a spec exposes, recovered from Bun's (working) runtime interop by
// importing the package in THIS process — the generator runs under the same Bun +
// resolution as the bundler (from apps/quay/daemon), so every spec resolves to the
// exact copy we bundle. We union the ES namespace with a CJS `module.exports` (its
// `default`) and keep only valid-identifier keys; `generate()` pins `NODE_ENV` to MODE
// first so we read the same production build we bundle. Caveat of importing-to-discover:
// a vendored spec must be import-safe under Bun (no `window`/`document` at module top
// level). True for the current list; a browser-only lib would need static discovery
// (e.g. cjs-module-lexer) instead.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
async function exportNames(spec: string): Promise<string[]> {
	const mod: Record<string, unknown> = await import(spec)
	const names = new Set<string>()
	for (const obj of [mod, mod.default]) {
		if (obj && typeof obj === 'object')
			for (const key of Object.keys(obj)) if (key !== 'default' && IDENT.test(key)) names.add(key)
	}
	return [...names]
}

// One plugin per build: serves the virtual entry, and externalizes the sibling specs
// by EXACT match. Bun's top-level `external` glob-matches a package and all its
// subpaths (so listing `react` would also externalize the `react/jsx-runtime` we're
// trying to build); an `onResolve` exact check externalizes only the precise siblings,
// so each module reaches the others through the import map — one shared React internals
// dispatcher, never a second copy (which is the classic "Invalid hook call" two-Reacts bug).
const ENTRY = 'quay-vendor:entry'
function vendorPlugin(
	spec: string,
	externals: ReadonlySet<string>,
	names: readonly string[]
): BunPlugin {
	return {
		name: 'quay-vendor',
		setup(build) {
			build.onResolve({ filter: new RegExp(`^${ENTRY}$`) }, () => ({
				path: ENTRY,
				namespace: 'quay-vendor'
			}))
			build.onLoad({ filter: /.*/, namespace: 'quay-vendor' }, () => ({
				contents: entrySource(spec, names),
				loader: 'js',
				resolveDir: import.meta.dirname
			}))
			build.onResolve({ filter: /.*/ }, (args) =>
				externals.has(args.path) ? { path: args.path, external: true } : undefined
			)
		}
	}
}

async function buildOne(spec: string): Promise<string> {
	const externals = new Set(vendorSpecs.filter((other) => other !== spec))
	const names = await exportNames(spec)
	const result = await Bun.build({
		entrypoints: [ENTRY],
		target: 'browser',
		format: 'esm',
		minify: true,
		// `quay-vendor:entry` has no slash, but pin the root anyway so Bun never probes
		// a derived directory on the real fs before the plugin resolves the virtual entry.
		root: import.meta.dirname,
		define: { 'process.env.NODE_ENV': JSON.stringify(MODE) },
		plugins: [vendorPlugin(spec, externals, names)],
		throw: false
	})
	if (!result.success) {
		for (const log of result.logs) console.error(log)
		throw new Error(`vendor: build failed for "${spec}"`)
	}
	const out = result.outputs[0]
	if (!out) throw new Error(`vendor: no output for "${spec}"`)
	return out.text()
}

async function generate(): Promise<void> {
	// Pin NODE_ENV before any spec import so `exportNames` loads the same production
	// build the bundler does (React's facades branch on this at require time).
	process.env.NODE_ENV = MODE
	// Clean rebuild so a removed spec leaves no stale file behind.
	await rm(OUT_DIR, { recursive: true, force: true })
	for (const spec of vendorSpecs) {
		const code = await buildOne(spec)
		const file = join(OUT_DIR, `${spec}.js`)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, code)
		console.log(`  ${vendorUrl(spec).padEnd(28)} ${(code.length / 1024).toFixed(1)} KB`)
	}
	console.log('\nimport map:')
	console.log(JSON.stringify(vendorImportMap(), null, 2))
}

if (import.meta.main) await generate()
