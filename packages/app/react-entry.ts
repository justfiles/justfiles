// Shared codegen for the React GUI shim. A `gui.tsx`/`gui.jsx` is, by
// convention, a React component module: it default-exports the component and
// may `export const menu`. We wrap it into the `export const gui =
// defineReactGUI(...)` the host GUI protocol expects. A `gui.ts` (no x) is the
// low-level escape hatch — a hand-written `defineGUI` module, used verbatim.
//
// The file extension is the whole signal, so there's no source scanning and no
// regex to fool with comments or strings. All three build paths use it —
// `kernelHost` (vite.ts), the dev server, and the frieren devkit — so the rule
// and the template live here once.
//
// Pure string work, no React/DOM/Node deps: safe to import from the
// native-Node-loaded vite plugin (bare specifier) and the browser devkit.

export const isReactGuiEntry = (entry: string): boolean => /\.[jt]sx$/.test(entry)

// The shim module source. `specifier` is the import path to the author's
// component as the generated file will see it (the caller resolves it for its
// own bundler). The component is the default export; the whole module namespace
// is forwarded as options, so an optional `export const menu` is picked up when
// present and is simply `undefined` when absent — no detection needed. A
// missing default export is a clear bundler error, which is the right failure.
export function reactGuiEntry(specifier: string): string {
	return `import Component, * as mod from ${JSON.stringify(specifier)}
import { defineReactGUI } from '@justfiles/app/react'

export const gui = defineReactGUI(Component, mod)
`
}
