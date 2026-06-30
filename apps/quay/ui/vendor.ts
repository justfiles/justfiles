// The browser-shared React layer. Each specifier below is bundled ONCE into a
// self-contained ESM module, served at `/vendor/<spec>.js`, and resolved through the
// page import map. So every app's `gui.js` links against a single shared React instance
// instead of bundling its own copy.
//
// This file is BOTH the generator and the source of truth for the import map
// (`import { vendorImportMap } from './vendor'`), so the served modules and the map are
// generated from the same list and can never drift. Run it directly to (re)generate the
// bundles — `bun ui/vendor.ts [outDir]` — or call `generate(outDir)`. The Vite plugin
// (vite.config.ts) spawns it from `closeBundle` to emit into dist/client/vendor (it must
// run under Bun, not Vite's Node process: Bun's bundler hoists react-dom's CJS
// `require("react")` to an ESM import, whereas esbuild emits a throwing __require shim for
// a browser external). The output is a build artifact (gitignored under dist/).

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
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

// A synthetic entry that re-exposes a package as clean ESM with EXPLICIT named
// exports — emitting `export const <name> = __ns[<name>]` for every name. We can't use
// the obvious `export * from spec`: no bundler carries a CJS module's named exports
// through a re-export to ESM output (Bun.build, esbuild, Rollup and Rolldown all emit
// only `export default` — see oven-sh/bun#12463, evanw/esbuild#442), and more decisively
// the browser's NATIVE ESM import — which is what resolves `/vendor/*.js` through the
// page import map at runtime — does no CJS interop at all, so the served module MUST
// physically declare each name or `import { createRoot } from 'react-dom/client'` throws
// "does not provide an export named 'createRoot'". The per-name re-export is the robust
// fix; `exportNames` (below) supplies the list by static analysis. The namespace
// re-export also hands back the default (a CJS module's `module.exports`) so
// `import X from "react"` keeps working too. Same shape for every spec.
const entrySource = (spec: string, names: readonly string[]): string =>
	`import * as __star from ${JSON.stringify(spec)}\n` +
	`const __ns = __star.default ?? __star\n` +
	`export default __ns\n` +
	names.map((n) => `export const ${n} = __ns[${JSON.stringify(n)}]\n`).join('')

// cjs-module-lexer can't evaluate react's `if (NODE_ENV === "production")` guard, so it
// always reports the dev branch of a reexport (`module.exports = require("./cjs/x.dev")`);
// swap to the `.production.` sibling that Bun.build actually inlines (MODE is 'production')
// when it exists. react's dev build re-exports two dev-only names (act, captureOwnerStack)
// the production build omits, so this keeps the declared exports matched to the values the
// bundle resolves them to.
const toBundled = (file: string): string => {
	const prod = file.replace('.development.', '.production.')
	return prod !== file && existsSync(prod) ? prod : file
}

// The export names a spec exposes, recovered by STATICALLY lexing the package's CJS source
// with cjs-module-lexer — the same lexer Node.js core uses to predict a CJS module's named
// exports for `import { x } from "pkg"` interop. Nothing executes, so (unlike the old
// import-to-discover approach) a browser-only lib with `window` at module top level lexes
// fine, and the names can't drift from a differently-resolved copy. We follow
// `module.exports = require("./cjs/…")` reexports the way Node does, resolving from the same
// place Bun.build does (this file's dir) so we read the exact copy we bundle.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
async function exportNames(spec: string): Promise<string[]> {
	const { init, parse } = await import('cjs-module-lexer')
	const require = createRequire(import.meta.url)
	await init()
	const names = new Set<string>()
	const walk = (file: string, seen: Set<string>): void => {
		if (seen.has(file)) return
		seen.add(file)
		const { exports, reexports } = parse(readFileSync(file, 'utf8'))
		for (const name of exports) if (name !== 'default' && IDENT.test(name)) names.add(name)
		for (const re of reexports)
			walk(toBundled(re.startsWith('.') ? resolve(dirname(file), re) : require.resolve(re)), seen)
	}
	walk(toBundled(require.resolve(spec)), new Set())
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

// Clean rebuild so a removed spec leaves no stale file behind. (Bun.build pins NODE_ENV
// via `define`, and `exportNames` reads the production build by path — see `toBundled` —
// so no ambient `process.env.NODE_ENV` is needed.)
export async function generate(
	outDir = join(import.meta.dirname, 'dist/client/vendor')
): Promise<void> {
	await rm(outDir, { recursive: true, force: true })
	for (const spec of vendorSpecs) {
		const code = await buildOne(spec)
		const file = join(outDir, `${spec}.js`)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, code)
		console.log(`  ${vendorUrl(spec).padEnd(28)} ${(code.length / 1024).toFixed(1)} KB`)
	}
	console.log('\nimport map:')
	console.log(JSON.stringify(vendorImportMap(), null, 2))
}

if (import.meta.main) await generate(process.argv[2])
