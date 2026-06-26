import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { build as bundleDts } from 'tsdown'
import { reactExternals, sdkRuntimeSpecs } from '../../runtime-specs.ts'
import { DEVKIT_SCHEMA, type DevkitIndex } from './devkit-sysroot.ts'
import type { TypePaths, TypesBundle } from './toolchain.ts'

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
	paths: TypePaths
}

export async function buildSdk(): Promise<SdkBuild> {
	const [runtime, baked] = await Promise.all([buildRuntime(), bakeTypes()])
	return { runtime, types: baked.files, paths: baked.paths }
}

// Write the app-code devkit sysroot (`devkit/**`) from a built SDK map. Kept with the
// Node-only builders so the Vite plugin stays a tiny packaging hook, while browser hosts
// keep importing only the dependency-free loader (`devkit-sysroot.ts`). Every file is
// stored content-addressed at `store/<sha256-…>` (deduped); `index.json` maps each
// logical path to its blob id, and the whole-sysroot `hash` digests that manifest.
const NODE_MODULES = 'node_modules/'
export async function writeSysroot(root: string, sdk?: SdkBuild): Promise<void> {
	const built = sdk ?? (await buildSdk())
	await rm(root, { recursive: true, force: true })
	const store = join(root, 'store')
	await mkdir(store, { recursive: true })
	const seen = new Set<string>()
	const put = async (content: string): Promise<string> => {
		const id = `sha256-${createHash('sha256').update(content).digest('hex')}`
		if (!seen.has(id)) {
			seen.add(id)
			await writeFile(join(store, id), content)
		}
		return id
	}
	const files: Record<string, string> = {}
	for (const [key, content] of Object.entries(built.types).sort(([a], [b]) => (a < b ? -1 : 1))) {
		const rel = key.startsWith(NODE_MODULES) ? key.slice(NODE_MODULES.length) : key
		files[rel] = await put(content)
	}
	const runtime: Record<string, string> = {}
	for (const [spec, content] of Object.entries(built.runtime).sort(([a], [b]) =>
		a < b ? -1 : 1
	)) {
		runtime[`${spec}.js`] = await put(content)
	}
	// Whole-sysroot hash: digest the (kind, logical path, blob id) manifest in sorted
	// order. Blob ids already capture content, so this versions the entire tree.
	const digest = createHash('sha256')
	for (const [rel, id] of Object.entries(files))
		digest.update('types').update('\0').update(rel).update('\0').update(id).update('\0')
	for (const [rel, id] of Object.entries(runtime))
		digest.update('runtime').update('\0').update(rel).update('\0').update(id).update('\0')
	const index: DevkitIndex = {
		schema: DEVKIT_SCHEMA,
		hash: `sha256-${digest.digest('hex')}`,
		files,
		runtime,
		paths: built.paths
	}
	await writeFile(join(root, 'index.json'), JSON.stringify(index, null, '\t'))
}

// ── Type-checker overlay (the `.d.ts` mirror of `buildRuntime`) ──────────────
//
// `typecheck` overlays a draft on an in-memory host. A shipped host (quay's bun exe,
// the browser container) has no `node_modules`, so `bakeTypes` collects the SDK + React
// `.d.ts` ONCE at build time into a `TypesBundle` plus a `TypePaths` import-map. The
// files are overlaid beside the draft's `src/`; tsc resolves our SDK specifiers through
// `paths` (explicit lookup, mirroring the runtime `spec → js` map) and the vendored
// externals through their own real `package.json` — so the same `typecheck` code runs
// hermetically, no fs, with `types` + `paths` supplied.

// Our SDK headers are ROLLED UP from source with tsdown (the `.d.ts` twin of
// `buildRuntime`'s esbuild pass): each `@justfiles/app` subpath in `sdkRuntimeSpecs`
// becomes one self-contained `.d.ts` (plus a couple of shared chunks), built straight
// from `.ts` SOURCE — no dependency on any prior workspace `tsc`/`tsdown` build. The
// workspace `@justfiles/fs` types are INLINED (`noExternal` + `dts.eager`, which lets
// rolldown follow fs's type-only barrel re-exports); react, valibot and
// `@standard-schema/spec` stay external (vendored, resolved via node resolution).
// `paths[spec]` points at the rolled entry.
async function buildTypes(): Promise<{ files: TypesBundle; paths: TypePaths }> {
	const appDir = packageDir(import.meta.dirname, '@justfiles/app')
	const exportsMap = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
		.exports as Record<string, string>
	const PREFIX = 'node_modules/@justfiles/app'
	const entry: Record<string, string> = {}
	const paths: TypePaths = {}
	for (const { spec } of sdkRuntimeSpecs) {
		if (spec !== '@justfiles/app' && !spec.startsWith('@justfiles/app/')) continue
		const sub = spec === '@justfiles/app' ? '.' : `.${spec.slice('@justfiles/app'.length)}`
		const src = exportsMap[sub]
		if (typeof src !== 'string') throw new Error(`devkit-runtime: no source export for ${spec}`)
		const name = sub === '.' ? 'index' : sub.slice(2)
		entry[name] = join(appDir, src)
		paths[spec] = [`${PREFIX}/${name}.d.ts`]
	}
	const out = await mkdtemp(join(tmpdir(), 'devkit-types-'))
	try {
		await bundleDts({
			entry,
			outDir: out,
			format: ['esm'],
			platform: 'neutral',
			// `eager` emits the full program declarations upfront so rolldown can follow
			// `@justfiles/fs`'s type-only barrel re-exports when inlining it.
			dts: { eager: true },
			// Pin to @justfiles/app's own tsconfig: cwd-independent (a caller at the repo
			// root would otherwise pick up the root tsconfig's project `references`).
			tsconfig: join(appDir, 'tsconfig.json'),
			// Force `.d.ts`/`.js` so the baked paths are deterministic — tsdown otherwise
			// picks `.d.mts` based on the CWD package.json `type`, which varies by caller.
			outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
			// `@justfiles/fs` is force-INLINED (tsdown auto-externalizes deps; this overrides).
			// react / valibot / @standard-schema stay external (vendored, node resolution).
			external: [...reactExternals, 'valibot', '@standard-schema/spec'],
			noExternal: ['@justfiles/fs'],
			clean: true,
			logLevel: 'silent',
			config: false
		})
		const files: TypesBundle = {}
		await collectDts(out, PREFIX, files)
		return { files, paths }
	} finally {
		await rm(out, { recursive: true, force: true })
	}
}

// External type roots the draft surface needs. React's types live in `@types/*` only
// — we deliberately DON'T bake the runtime `react`/`react-dom` packages: their
// `exports` map would resolve `react/jsx-runtime` to a `.js` absent from the overlay
// and shadow the `@types` fallback, leaving JSX without its intrinsic elements. Their
// own transitive `dependencies` (csstype under @types/react, @standard-schema/spec
// under valibot, …) are pulled in automatically below. Externals keep their REAL
// `package.json` and resolve by node resolution (no `paths` entry).
const TYPE_EXTERNAL = ['valibot', '@types/react', '@types/react-dom', 'type-fest']

export async function bakeTypes(): Promise<{ files: TypesBundle; paths: TypePaths }> {
	const app = await buildTypes()
	const bundle: TypesBundle = { ...app.files }
	const paths: TypePaths = { ...app.paths }
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
	return { files: bundle, paths }
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
