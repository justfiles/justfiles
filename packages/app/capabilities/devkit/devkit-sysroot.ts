// The devkit sysroot — the fixed SDK a host injects into draft compiles. app-code ships
// it at `devkit/**` (`packages/app-code/devkit-sysroot.ts`): `.d.ts` headers for
// typecheck plus SDK runtime JS for bundle input, indexed by `index.json`. Hosts load it
// from the calling app's installed bundle, so devkit needs no node_modules or host
// package resolver.
//
// Deliberately tiny + dependency-free (the `TypesBundle` TYPE from toolchain.ts is
// erased at runtime, and runtime-specs.ts is a bare list): the app-code build PLUGIN
// imports `DEVKIT_SCHEMA`/`DevkitIndex` from here in Vite's config context, so this
// must never drag in the kernel/fs graph.

import { sdkRuntimeSpecs } from '../../runtime-specs.ts'
import type { TypePaths, TypesBundle } from './toolchain.ts'

// `justfiles.devkit.v1`. The schema tag app-code stamps into `devkit/index.json` and
// hosts read back — shared so writer (the build plugin) and reader (`loadTypes`) agree.
export const DEVKIT_SCHEMA = 'justfiles.devkit.v1'

// `devkit/index.json`: the sysroot manifest. `hash` is the content version + cache key
// (sha256 over the manifest); `files` maps each header's logical path (UNDER
// `node_modules/`) to its blob id, `runtime` maps each bundle-able module path
// (`@justfiles/app.js`, `valibot.js`, …) to its blob id,
// and `paths` is the tsc import-map (SDK specifier → entry `.d.ts`) the typecheck overlay
// injects. Every blob lives content-addressed at `devkit/store/<id>` (id = `sha256-…`),
// so identical content is stored once and reads are integrity-checkable. Loaders
// assemble the maps with bare `read` calls and no directory scan (an installed app only
// exposes `read`, not a lister).
export interface DevkitIndex {
	schema: string
	hash: string
	files: Record<string, string>
	runtime?: Record<string, string>
	paths?: TypePaths
}

// The overlay key tsc resolution needs (`node_modules/<pkg>/…`). The sysroot ships the
// tree WITHOUT a literal `node_modules` dir (publish/tooling strip it); the loader
// prepends it back, mirroring the build plugin's strip on write.
const NODE_MODULES = 'node_modules/'

// Load an app's type sysroot (shipped at `devkit/**`): the `.d.ts` overlay (keyed
// `node_modules/<pkg>/…`) plus the `paths` import-map tsc resolves our SDK through.
// `index.files` maps each logical path to a `devkit/store/<id>` blob the loader reads
// back. `read` is host-supplied — quay/frieren read the installed app's bytes
// (`kernel.app(appId).read`), tests an in-memory map — so the loader never touches a
// real fs or `node_modules`. Eager + fully in-memory (the tree is small); callers cache
// it by `{ appId, hash }`. A missing/invalid `index.json` is a clear error, never a
// silent `node_modules` read.
export async function loadTypes(
	read: (path: string) => Promise<Uint8Array>
): Promise<{ files: TypesBundle; paths: TypePaths }> {
	const index = await loadIndex(read)
	const files: TypesBundle = {}
	for (const [rel, id] of Object.entries(index.files))
		files[`${NODE_MODULES}${rel}`] = new TextDecoder().decode(await read(`devkit/store/${id}`))
	return { files, paths: index.paths ?? {} }
}

// Load the runtime sysroot into the bundler's virtual runtime map (specifier → JS
// source). This is the JS twin of `loadTypes`: same installed bundle, no node_modules.
// It carries the whole SDK, so a draft bundle is self-contained and the host serves no
// library bytes.
//
// The map IS the set of specifiers a draft may import — a compile resolves against it
// and nothing else. So completeness is checked once, here, against the SDK's own list:
// an app-code bundle older than the host's SDK would otherwise surface as an opaque
// "unsupported package" on whichever draft first imported the missing module.
export async function loadRuntime(
	read: (path: string) => Promise<Uint8Array>
): Promise<Record<string, string>> {
	const index = await loadIndex(read)
	if (!index.runtime) throw new Error('devkit: missing runtime list in devkit/index.json')
	const runtime: Record<string, string> = {}
	for (const [rel, id] of Object.entries(index.runtime)) {
		const spec = rel.endsWith('.js') ? rel.slice(0, -3) : rel
		runtime[spec] = new TextDecoder().decode(await read(`devkit/store/${id}`))
	}
	const missing = sdkRuntimeSpecs.filter((spec) => !(spec in runtime))
	if (missing.length)
		throw new Error(`devkit: sysroot is missing runtime module(s): ${missing.join(', ')}`)
	return runtime
}

async function loadIndex(read: (path: string) => Promise<Uint8Array>): Promise<DevkitIndex> {
	try {
		return JSON.parse(new TextDecoder().decode(await read('devkit/index.json')))
	} catch (cause) {
		throw new Error('devkit: missing or invalid devkit/index.json sysroot', { cause })
	}
}
