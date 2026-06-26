// Shared build lists for app bundling. App artifacts bundle the SDK into their own
// `app.js`/`gui.js`; only React stays external for the GUI so the host document keeps one
// React singleton. The SDK list below is therefore the devkit/runtime allowlist, not a GUI
// external list (the name is historical until the cleanup step).

// React family. Externalized in the GUI compile only — the host importmap resolves a
// bare `react` to the one shared React instance in the document. A reducer worker has no
// importmap, so React MUST NOT appear in a reducer-reachable module; `buildRuntime`
// guards that (see `sdkExternals` `reducer` below).
export const reactExternals = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

// The platform SDK + valibot, each pre-built by the host once (`buildRuntime`) into a
// self-contained ESM module and fed to devkit compiles as bundle-able source. During the
// transition, hosts may also serve these at `/vendor/<spec>.js`; vendor URLs MIRROR the
// specifier — no hyphen-mangling — because a path with `@`/`/` is a valid URL
// (`@justfiles/app/capabilities/volume` → `/vendor/@justfiles/app/capabilities/volume.js`).
//
// `reducer: true` = reducer-reachable, so it must stay react-free. `@justfiles/app/react`
// (the React GUI entry) and `@justfiles/app/browser` (the `defineGUI` host bindings) are
// GUI-only and may pull React, so they're `reducer: false` and excluded from the guard.
//
// This list must enumerate every SDK subpath app-code may import so the virtual devkit
// resolver can map it to bundled runtime source. `devkit` (Code) and `accounts` (Settings)
// are gated at the host, but their client factories are imported by those apps, so they're
// present like the rest; the grant is enforced on invocation, never on import.
export const sdkExternals: readonly { spec: string; reducer: boolean }[] = [
	{ spec: '@justfiles/app', reducer: true },
	{ spec: '@justfiles/app/react', reducer: false },
	{ spec: '@justfiles/app/browser', reducer: false },
	{ spec: '@justfiles/app/capabilities/volume', reducer: true },
	{ spec: '@justfiles/app/capabilities/notify', reducer: true },
	{ spec: '@justfiles/app/capabilities/email', reducer: true },
	{ spec: '@justfiles/app/capabilities/calendar', reducer: true },
	{ spec: '@justfiles/app/capabilities/ai', reducer: true },
	{ spec: '@justfiles/app/capabilities/devkit', reducer: true },
	{ spec: '@justfiles/app/capabilities/accounts', reducer: true },
	{ spec: 'valibot', reducer: true }
]

// Every Vite app GUI externalized specifier. SDK imports are bundled.
export const externals = [...reactExternals]

const SDK_SPECS = new Set(sdkExternals.map((s) => s.spec))

// Is `spec` a platform SDK specifier? Devkit bundles these from the host-supplied
// `runtime` source. React is handled separately via the bundler's top-level `external`, so
// it's deliberately not in this set.
export function isSdkSpec(spec: string): boolean {
	return SDK_SPECS.has(spec)
}

// Transitional `/vendor/<spec>.js` URL for hosts that still serve the SDK runtime as
// modules/data. React keeps its existing mangled vendor names.
export function vendorUrl(spec: string): string {
	return `/vendor/${spec}.js`
}
