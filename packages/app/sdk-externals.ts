// The platform-framework specifiers app code links against the HOST's copy instead of
// bundling — the dylib / VS Code `vscode`-module model. This is the ONE source of truth
// for "what is external": the gui compile marks these specifiers external (resolved by the
// host importmap), and the host importmap / vendor emit is generated from it — so the
// author surface, the gui resolver, and the served modules can't drift. The reducer
// compile does NOT externalize the SDK: it bundles every referenced module into `app.js`
// (the worker has no importmap), so there is no spawn-time rewrite to keep in sync.

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
// self-contained ESM module and served at `/vendor/<spec>.js` (for the gui importmap) and
// fed to the reducer compile as bundle-able source. Vendor URLs MIRROR the specifier — no
// hyphen-mangling — because a path with `@`/`/` is a valid URL
// (`@justfiles/app/capabilities/volume` → `/vendor/@justfiles/app/capabilities/volume.js`).
//
// `reducer: true` = reducer-reachable, so it must stay react-free. `@justfiles/app/react`
// (the React GUI entry) and `@justfiles/app/browser` (the `defineGUI` host bindings) are
// GUI-only and may pull React, so they're `reducer: false` and excluded from the guard.
//
// NOTE: esbuild's `external` matches a package AND all its subpaths, so the gui compile
// externalizes EVERY `@justfiles/app/*` import it makes — which means this list must
// enumerate every capability-client subpath an app can import (not just the USE
// capabilities). `devkit` (Code) and `accounts` (Settings) are gated at the host, but their
// client factories are imported by those apps, so they're vendored like the rest; the grant
// is enforced on invocation, never on import.
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

// Every externalized specifier — the React family + the SDK allowlist the gui compile
// marks external (and the importmap resolves).
export const externals = [...reactExternals]

const SDK_SPECS = new Set(sdkExternals.map((s) => s.spec))

// Is `spec` a platform SDK specifier? The gui compile externalizes these as BARE specifiers
// (kept for the host importmap); the reducer compile bundles them from the host's pre-built
// `runtime` source. React is handled separately via the bundler's top-level `external`, so
// it's deliberately not in this set.
export function isSdkSpec(spec: string): boolean {
	return SDK_SPECS.has(spec)
}

// The `/vendor/<spec>.js` URL a specifier resolves to (importmap value for the gui). React
// keeps its existing mangled vendor names, so this is the SDK half of the importmap;
// callers merge it with the React entries.
export function vendorUrl(spec: string): string {
	return `/vendor/${spec}.js`
}
