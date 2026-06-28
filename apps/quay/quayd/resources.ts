// Where the daemon finds its on-disk resources — the one place that knows the dev vs.
// shipped layout. In DEV quayd runs from the source tree: assets-dist sits beside it,
// @justfiles/design resolves from node_modules, the booter from native/build, and a
// cold respawn re-runs the current runtime on main.ts. SHIPPED, quayd is the
// self-contained exe at Quay.app/Contents/MacOS/quayd with everything flat under
// ../Resources, and a respawn just re-runs the exe (no script, no loaders).
//
// build-exe.ts injects QUAY_SHIPPED into the standalone so it resolves the bundle next
// to the exe instead of the bunfs root. Every other module reads paths from here.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
export const SHIPPED = process.env.QUAY_SHIPPED === '1'

// Shipped: Contents/MacOS/quayd -> ../Resources. Dev: the quayd source dir.
const ROOT = SHIPPED ? join(dirname(process.execPath), '..', 'Resources') : import.meta.dirname

// Launcher vendor/boot/chat bundles (build-assets.ts) + the agent docs copied beside them.
export const ASSETS_DIR = join(ROOT, 'assets-dist')
export const DOCS_DIR = join(ASSETS_DIR, 'docs')
export const BUILTINS_DIR = join(ROOT, 'builtins')

// @justfiles/design stylesheets quayd serves under /design: dev resolves from
// node_modules, ship reads the copies under Resources/design.
export function designPath(name: string): string {
	return SHIPPED ? join(ROOT, 'design', name) : require.resolve(`@justfiles/design/${name}`)
}
