import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import type { TypesBundle } from './toolchain.ts'

// The system libraries the devkit compiler injects into every draft bundle — the
// "stdlib shipped with the OS." Each is pre-bundled once (here, with Node esbuild
// — at frieren build/serve time, or in the desktop main process) into a
// self-contained ESM module, then handed to the `compile` engine as a virtual
// runtime so drafts compile hermetically with no node_modules. React is NOT here:
// it stays external and resolves through the host importmap so the preview shares
// the one host React instance.
//
// This is the one Node-only piece of the devkit pipeline (it imports the native
// esbuild engine), kept in its own subpath so the browser-safe `@justfiles/app/
// devkit` (engine-injected) never pulls native esbuild into a browser host.
const EXTERNAL = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

const LIBS = ['@justfiles/app', '@justfiles/app/browser', '@justfiles/app/react', 'valibot']

// The capability factories an app author declares + invokes. Each is the typed
// `defineCapability(...)` factory (`volume({ scopes }) → { id, scopes }`): the
// SAME `{ id, scopes }` shape the kernel reads at runtime, but carrying the
// method/stream contract so `app.invoke('volume', 'mkdir', …)` is typed. Without
// these a draft must hand-roll a `{ id, scopes }` stub, which has no `__methods`
// and collapses `invoke`'s method argument to `never`. `accounts` (allowlist-gated
// admin) and `devkit` (the build capability itself) stay off the author surface.
const CAPS = [
	'@justfiles/app/capabilities/volume',
	'@justfiles/app/capabilities/notify',
	'@justfiles/app/capabilities/email',
	'@justfiles/app/capabilities/calendar',
	'@justfiles/app/capabilities/ai'
]

export async function buildRuntime(): Promise<Record<string, string>> {
	const require = createRequire(import.meta.url)
	const runtime: Record<string, string> = {}
	for (const spec of [...LIBS, ...CAPS]) {
		// Re-export the package from a synthetic entry rather than bundling its
		// resolved file directly. A CommonJS package (e.g. valibot) used as the
		// entry collapses to a lone `export default`, so a draft's
		// `import * as v from 'valibot'` sees no named exports and `v.object`
		// compiles to `(void 0)`. Importing it here lets esbuild apply ESM
		// conditions + CJS named-export detection, preserving `object`,
		// `string`, … as real named exports.
		const result = await build({
			stdin: {
				contents: `export * from ${JSON.stringify(spec)}`,
				resolveDir: dirname(require.resolve(spec)),
				loader: 'js'
			},
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
			external: EXTERNAL
		})
		const output = result.outputFiles[0]
		if (!output) throw new Error(`devkit-runtime: no output for ${spec}`)
		runtime[spec] = output.text
	}
	return runtime
}

// ── Type-checker overlay (the `.d.ts` mirror of `buildRuntime`) ──────────────
//
// `typecheck` overlays a draft on an in-memory host that, in dev, falls through to
// the real `node_modules` for the SDK/React `.d.ts`. A shipped host (quay's bun exe,
// the browser container) has no `node_modules`, so `bakeTypes` collects those `.d.ts`
// ONCE at build time into a `TypesBundle` keyed as a `node_modules/<pkg>/…` tree.
// Overlaid beside the draft's `src/`, normal node/bundler resolution finds it — so
// the same `typecheck` code runs hermetically, no fs, with `types` supplied.

// Workspace packages expose types through their built `dist/*.d.ts` — their dev
// `exports` point at `.ts` SOURCE, which `skipLibCheck` can't skip, so we bake dist
// under a package.json whose `exports` (from publishConfig) resolve to those `.d.ts`.
const TYPE_WORKSPACE = ['@justfiles/app', '@justfiles/fs']
// External type roots the draft surface needs. React's types live in `@types/*` only
// — we deliberately DON'T bake the runtime `react`/`react-dom` packages: their
// `exports` map would resolve `react/jsx-runtime` to a `.js` absent from the overlay
// and shadow the `@types` fallback, leaving JSX without its intrinsic elements. Their
// own transitive `dependencies` (csstype under @types/react, @standard-schema/spec
// under valibot, …) are pulled in automatically below.
const TYPE_EXTERNAL = ['valibot', '@types/react', '@types/react-dom', 'type-fest']

export async function bakeTypes(): Promise<TypesBundle> {
	const bundle: TypesBundle = {}
	// Workspace SDK packages: bake built dist `.d.ts` under a synthesized package.json
	// whose `exports` (from publishConfig) resolve to them — the dev `exports` point at
	// `.ts` source, which `skipLibCheck` can't skip.
	for (const name of TYPE_WORKSPACE) {
		const dir = packageDir(import.meta.dirname, name)
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
		await collectDts(join(dir, 'dist'), `node_modules/${name}/dist`, bundle)
		bundle[`node_modules/${name}/package.json`] = JSON.stringify({
			name,
			version: pkg.version,
			exports: pkg.publishConfig.exports
		})
	}
	// External packages + their transitive `dependencies` (BFS), each resolved by
	// walking node_modules up from its dependent's own dir so pnpm's nesting is
	// followed. Flat `node_modules/<pkg>` keys — pnpm hoists to one version, and node
	// resolution walks up to find them.
	const seen = new Set<string>()
	const queue = TYPE_EXTERNAL.map((name) => ({ name, from: import.meta.dirname }))
	for (let job = queue.shift(); job; job = queue.shift()) {
		if (seen.has(job.name)) continue
		seen.add(job.name)
		const dir = packageDir(job.from, job.name)
		await collectDts(dir, `node_modules/${job.name}`, bundle)
		const manifest = readFileSync(join(dir, 'package.json'), 'utf8')
		bundle[`node_modules/${job.name}/package.json`] = manifest
		for (const dep of Object.keys(JSON.parse(manifest).dependencies ?? {}))
			queue.push({ name: dep, from: dir })
	}
	return bundle
}

// A package's root dir. First an fs walk up `node_modules` from `fromDir` (resolving
// the pnpm symlink to its real `.pnpm/…` home) — this handles types-only packages
// (type-fest) and restrictive `exports` maps that `require.resolve` can't see. Falls
// back to resolving the entry and walking up to the package.json naming it, which
// covers workspace packages with no `node_modules/<self>` on the walk path.
function packageDir(fromDir: string, name: string): string {
	for (let dir = fromDir; ; ) {
		const candidate = join(dir, 'node_modules', name)
		if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
		const up = dirname(dir)
		if (up === dir) break
		dir = up
	}
	let dir = dirname(createRequire(join(fromDir, 'package.json')).resolve(name))
	for (;;) {
		const pj = join(dir, 'package.json')
		if (existsSync(pj) && JSON.parse(readFileSync(pj, 'utf8')).name === name) return dir
		const up = dirname(dir)
		if (up === dir) throw new Error(`devkit-runtime: package dir not found for ${name}`)
		dir = up
	}
}

// Recursively copy every declaration file under `dir` into `bundle` keyed
// `<prefix>/<rel>`. Includes `.d.mts`/`.d.cts` (valibot ships those, not `.d.ts`) and
// skips nested `node_modules` (pnpm hoists; each package is listed in its own right).
const DTS = /\.d\.[mc]?ts$/
async function collectDts(dir: string, prefix: string, bundle: TypesBundle): Promise<void> {
	if (!existsSync(dir)) return
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue
		const abs = join(dir, entry.name)
		if (entry.isDirectory()) await collectDts(abs, `${prefix}/${entry.name}`, bundle)
		else if (DTS.test(entry.name)) bundle[`${prefix}/${entry.name}`] = await readFile(abs, 'utf8')
	}
}
