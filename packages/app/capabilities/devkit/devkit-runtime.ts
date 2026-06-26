import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { reactExternals, sdkRuntimeSpecs } from '../../runtime-specs.ts'
import { DEVKIT_SCHEMA, type DevkitIndex } from './devkit-sysroot.ts'
import type { TypesBundle } from './toolchain.ts'

// The system libraries app-code bakes into self-contained runtime modules — the "stdlib
// shipped with the OS." Each spec in `sdkRuntimeSpecs` is built once (here, with Node
// esbuild), with React left external (`reactExternals`) so the one host React is shared.
// Devkit feeds these modules to the bundler as source and inlines SDK imports into both
// `app.js` and `gui.js`. React itself is vendored separately by each host.
//
// This is the one Node-only piece of the devkit pipeline (it imports the native
// esbuild engine), kept in its own subpath so the browser-safe `@justfiles/app/
// devkit` (engine-injected) never pulls native esbuild into a browser host.

// A reducer-reachable SDK module must contain no bare React import: the reducer worker
// has no importmap to resolve one, so it would fail with an opaque worker error. React
// is the only external in the build below, so any react-family import here is a real bug.
const REACT_FAMILY = /^react(-dom)?(\/|$)/
function assertReducerReactFree(spec: string, source: string): void {
	for (const m of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
		const dep = m[1] as string
		if (REACT_FAMILY.test(dep))
			throw new Error(
				`devkit-runtime: reducer-reachable SDK module "${spec}" imports "${dep}" — a reducer ` +
					`worker has no importmap to resolve a bare React specifier. Keep React out of ` +
					`@justfiles/app core, the capability subpaths, and valibot.`
			)
	}
}

export async function buildRuntime(): Promise<Record<string, string>> {
	const require = createRequire(import.meta.url)
	const runtime: Record<string, string> = {}
	for (const { spec, reducer } of sdkRuntimeSpecs) {
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
			external: reactExternals
		})
		const output = result.outputFiles[0]
		if (!output) throw new Error(`devkit-runtime: no output for ${spec}`)
		if (reducer) assertReducerReactFree(spec, output.text)
		runtime[spec] = output.text
	}
	return runtime
}

export interface SdkBuild {
	runtime: Record<string, string>
	types: TypesBundle
}

export async function buildSdk(): Promise<SdkBuild> {
	const [runtime, types] = await Promise.all([buildRuntime(), bakeTypes()])
	return { runtime, types }
}

// Write the app-code devkit sysroot (`devkit/**`) from a built SDK map. Kept with the
// Node-only builders so the Vite plugin stays a tiny packaging hook, while browser hosts
// keep importing only the dependency-free loader (`devkit-sysroot.ts`).
const NODE_MODULES = 'node_modules/'
export async function writeSysroot(root: string, sdk?: SdkBuild): Promise<void> {
	const built = sdk ?? (await buildSdk())
	await rm(root, { recursive: true, force: true })
	const digest = createHash('sha256')
	const files: string[] = []
	for (const [key, content] of Object.entries(built.types).sort(([a], [b]) => (a < b ? -1 : 1))) {
		const rel = key.startsWith(NODE_MODULES) ? key.slice(NODE_MODULES.length) : key
		const file = join(root, 'types', rel)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, content)
		files.push(rel)
		digest.update('types').update('\0').update(rel).update('\0').update(content).update('\0')
	}
	const runtime: string[] = []
	for (const [spec, content] of Object.entries(built.runtime).sort(([a], [b]) =>
		a < b ? -1 : 1
	)) {
		const rel = `${spec}.js`
		const file = join(root, 'runtime', rel)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, content)
		runtime.push(rel)
		digest.update('runtime').update('\0').update(rel).update('\0').update(content).update('\0')
	}
	const index: DevkitIndex = {
		schema: DEVKIT_SCHEMA,
		hash: `sha256-${digest.digest('hex')}`,
		files,
		runtime
	}
	await writeFile(join(root, 'index.json'), JSON.stringify(index, null, '\t'))
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
		const dist = join(dir, 'dist')
		const copied = await collectDts(dist, `node_modules/${name}/dist`, bundle)
		if (copied === 0)
			throw new Error(`devkit-runtime: missing ${name} declaration build at ${dist}`)
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
async function collectDts(dir: string, prefix: string, bundle: TypesBundle): Promise<number> {
	if (!existsSync(dir)) return 0
	let copied = 0
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue
		const abs = join(dir, entry.name)
		if (entry.isDirectory()) copied += await collectDts(abs, `${prefix}/${entry.name}`, bundle)
		else if (DTS.test(entry.name)) {
			bundle[`${prefix}/${entry.name}`] = await readFile(abs, 'utf8')
			copied += 1
		}
	}
	return copied
}
