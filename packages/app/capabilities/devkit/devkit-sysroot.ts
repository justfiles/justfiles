// The types-only devkit sysroot — the "headers" half of the build pipeline. app-code
// ships a sysroot at `devkit/**` (`packages/app-code/devkit-sysroot.ts`): the `.d.ts`
// surface a draft typechecks against, plus an `index.json` manifest. A host loads it
// into the tsc overlay (`node_modules/<pkg>/…`) at typecheck time. The SDK *runtime*
// is the host's (the served `/vendor/<spec>.js` modules); this is types only.
//
// Deliberately tiny + dependency-free (only the `TypesBundle` TYPE from toolchain.ts,
// erased at runtime): the app-code build PLUGIN imports `DEVKIT_SCHEMA`/`DevkitIndex`
// from here in Vite's config context, so this must never drag in the kernel/fs graph.

import type { TypesBundle } from './toolchain.ts'

// `justfiles.devkit.v1`. The schema tag app-code stamps into `devkit/index.json` and
// hosts read back — shared so writer (the build plugin) and reader (`loadTypes`) agree.
export const DEVKIT_SCHEMA = 'justfiles.devkit.v1'

// `devkit/index.json`: the sysroot manifest. `hash` is the content version + cache key
// (sha256 over every header); `files` lists each header's path UNDER `devkit/types/`,
// so the loader assembles the overlay with a bare `read` and no directory scan (an
// installed app only exposes `read`, not a lister).
export interface DevkitIndex {
	schema: string
	hash: string
	files: string[]
}

// The overlay key tsc resolution needs (`node_modules/<pkg>/…`). The sysroot ships the
// tree WITHOUT a literal `node_modules` dir (publish/tooling strip it); the loader
// prepends it back, mirroring the build plugin's strip on write.
const NODE_MODULES = 'node_modules/'

// Load an app's types-only sysroot (shipped at `devkit/**`) into a tsc overlay keyed
// `node_modules/<pkg>/…`. `read` is host-supplied — quay/desktop read the installed
// app's bytes (`kernel.app(appId).read`), frieren the seeded Volume, tests an in-memory
// map — so the loader never touches a real fs or `node_modules`. Eager + fully
// in-memory (the tree is <1 MB); callers cache it by `{ appId, hash }`. A
// missing/invalid `index.json` is a clear error, never a silent `node_modules` read.
export async function loadTypes(read: (path: string) => Promise<Uint8Array>): Promise<TypesBundle> {
	let index: DevkitIndex
	try {
		index = JSON.parse(new TextDecoder().decode(await read('devkit/index.json')))
	} catch (cause) {
		throw new Error('devkit: missing or invalid devkit/index.json sysroot', { cause })
	}
	const bundle: TypesBundle = {}
	for (const rel of index.files)
		bundle[`${NODE_MODULES}${rel}`] = new TextDecoder().decode(await read(`devkit/types/${rel}`))
	return bundle
}
