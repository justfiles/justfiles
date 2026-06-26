// The devkit sysroot — the fixed SDK a host injects into draft compiles. app-code ships
// it at `devkit/**` (`packages/app-code/devkit-sysroot.ts`): `.d.ts` headers for
// typecheck plus SDK runtime JS for bundle input, indexed by `index.json`. Hosts load it
// from the calling app's installed bundle, so devkit needs no node_modules or host
// package resolver.
//
// Deliberately tiny + dependency-free (only the `TypesBundle` TYPE from toolchain.ts,
// erased at runtime): the app-code build PLUGIN imports `DEVKIT_SCHEMA`/`DevkitIndex`
// from here in Vite's config context, so this must never drag in the kernel/fs graph.

import type { TypePaths, TypesBundle } from './toolchain.ts'

// `justfiles.devkit.v1`. The schema tag app-code stamps into `devkit/index.json` and
// hosts read back — shared so writer (the build plugin) and reader (`loadTypes`) agree.
export const DEVKIT_SCHEMA = 'justfiles.devkit.v1'

// `devkit/index.json`: the sysroot manifest. `hash` is the content version + cache key
// (sha256 over every sysroot file); `files` lists each header's path UNDER
// `devkit/types/`, `runtime` lists each SDK module path UNDER `devkit/runtime/`, and
// `paths` is the tsc import-map (SDK specifier → entry `.d.ts`) the typecheck overlay
// injects. Loaders assemble the maps with bare `read` calls and no directory scan (an
// installed app only exposes `read`, not a lister).
export interface DevkitIndex {
	schema: string
	hash: string
	files: string[]
	runtime?: string[]
	paths?: TypePaths
}

// The overlay key tsc resolution needs (`node_modules/<pkg>/…`). The sysroot ships the
// tree WITHOUT a literal `node_modules` dir (publish/tooling strip it); the loader
// prepends it back, mirroring the build plugin's strip on write.
const NODE_MODULES = 'node_modules/'

// Load an app's type sysroot (shipped at `devkit/**`): the `.d.ts` overlay (keyed
// `node_modules/<pkg>/…`) plus the `paths` import-map tsc resolves our SDK through.
// `read` is host-supplied — quay/desktop/frieren read the installed app's bytes
// (`kernel.app(appId).read`), tests an in-memory map — so the loader never touches a
// real fs or `node_modules`. Eager + fully in-memory (the tree is small); callers cache
// it by `{ appId, hash }`. A missing/invalid `index.json` is a clear error, never a
// silent `node_modules` read.
export async function loadTypes(
	read: (path: string) => Promise<Uint8Array>
): Promise<{ files: TypesBundle; paths: TypePaths }> {
	const index = await loadIndex(read)
	const files: TypesBundle = {}
	for (const rel of index.files)
		files[`${NODE_MODULES}${rel}`] = new TextDecoder().decode(await read(`devkit/types/${rel}`))
	return { files, paths: index.paths ?? {} }
}

// Load the SDK runtime sysroot into the bundler's virtual runtime map (specifier → JS
// source). This is the JS twin of `loadTypes`: same installed bundle, no node_modules,
// no host `/vendor` dependency.
export async function loadRuntime(
	read: (path: string) => Promise<Uint8Array>
): Promise<Record<string, string>> {
	const index = await loadIndex(read)
	if (!index.runtime) throw new Error('devkit: missing runtime list in devkit/index.json')
	const runtime: Record<string, string> = {}
	for (const rel of index.runtime) {
		const spec = rel.endsWith('.js') ? rel.slice(0, -3) : rel
		runtime[spec] = new TextDecoder().decode(await read(`devkit/runtime/${rel}`))
	}
	return runtime
}

async function loadIndex(read: (path: string) => Promise<Uint8Array>): Promise<DevkitIndex> {
	try {
		return JSON.parse(new TextDecoder().decode(await read('devkit/index.json')))
	} catch (cause) {
		throw new Error('devkit: missing or invalid devkit/index.json sysroot', { cause })
	}
}
