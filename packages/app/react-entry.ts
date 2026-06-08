// Shared codegen for the React GUI shim, used by all three build paths —
// `kernelHost` (vite.ts), the dev server, and the frieren devkit — so the rule
// and the template live here once.
//
// A `.ts` entry is the low-level escape hatch: a hand-written `defineGUI`
// module used verbatim (no shim). A `.tsx`/`.jsx` entry goes through the shim
// below, which accepts both JSX shapes off the module's own exports — no source
// scanning, no regex to fool with comments or strings:
//   - a React component module default-exports the component (and may
//     `export const menu`), which `reactGui` wraps;
//   - an imperative `defineGUI` module that happens to need JSX `export const
//     gui` directly, which `reactGui` forwards verbatim.
// The extension alone can't tell these apart — JSX forces `.tsx` either way —
// so the export, not the filename, is the signal.
//
// Pure string work, no React/DOM/Node deps: safe to import from the
// native-Node-loaded vite plugin (bare specifier) and the browser devkit.

export const isReactGuiEntry = (entry: string): boolean => /\.[jt]sx$/.test(entry)

// The shim module source. `specifier` is the import path to the author's module
// as the generated file will see it (the caller resolves it for its own
// bundler). We import only the namespace — a static default import of an
// escape-hatch module (which has no default export) would itself be a link
// error — and hand it to `reactGui`, which forwards `gui` when present or wraps
// the default-exported component, picking up an optional `menu` along the way.
export function reactGuiEntry(specifier: string): string {
	return `import * as mod from ${JSON.stringify(specifier)}
import { reactGui } from '@justfiles/app/react'

export const gui = reactGui(mod)
`
}
