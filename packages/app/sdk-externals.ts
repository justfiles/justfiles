// The platform-framework specifiers app code links against the HOST's copy instead of
// bundling — the dylib / VS Code `vscode`-module model. This is the ONE source of truth
// for "what is external": both compile paths (kernelHost and the devkit toolchain) read
// it to mark these specifiers external, and the host importmap / vendor emit is generated
// from it — so the author surface, both resolvers, and the served modules can't drift.

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
// self-contained ESM module and served at `/vendor/<spec>.js`. Vendor URLs MIRROR the
// specifier — no hyphen-mangling — because a path with `@`/`/` is a valid URL
// (`@justfiles/app/capabilities/volume` → `/vendor/@justfiles/app/capabilities/volume.js`).
//
// `reducer: true` = reducer-reachable, so it must stay react-free. `@justfiles/app/react`
// (the React GUI entry) and `@justfiles/app/browser` (the `defineGUI` host bindings) are
// GUI-only and may pull React, so they're `reducer: false` and excluded from the guard.
export const sdkExternals: readonly { spec: string; reducer: boolean }[] = [
	{ spec: '@justfiles/app', reducer: true },
	{ spec: '@justfiles/app/react', reducer: false },
	{ spec: '@justfiles/app/browser', reducer: false },
	{ spec: '@justfiles/app/capabilities/volume', reducer: true },
	{ spec: '@justfiles/app/capabilities/notify', reducer: true },
	{ spec: '@justfiles/app/capabilities/email', reducer: true },
	{ spec: '@justfiles/app/capabilities/calendar', reducer: true },
	{ spec: '@justfiles/app/capabilities/ai', reducer: true },
	{ spec: 'valibot', reducer: true }
]

// Every externalized specifier — the allowlist both compile-path resolvers mark external.
export const externals = [...reactExternals, ...sdkExternals.map((s) => s.spec)]

// The reducer sentinel prefix. A reducer worker has no importmap, so the compiler can't
// leave a bare SDK specifier — it emits `justfiles-sdk:<spec>` and the host rewrites each
// at spawn to a module URL the worker can load. Shared by BOTH compile paths (Step 2) and
// the spawn resolver (Step 3) so the emitted sentinel and the rewrite can't drift.
export const SDK_SENTINEL = 'justfiles-sdk:'

const SDK_SPECS = new Set(sdkExternals.map((s) => s.spec))

// Is `spec` a platform SDK specifier? Both compile paths externalize these as BARE
// specifiers (the gui keeps them for the host importmap; the reducer's are then rewritten
// by `sentinelizeReducer`). React is handled separately via the bundler's top-level
// `external`, so it's deliberately not in this set.
export function isSdkSpec(spec: string): boolean {
	return SDK_SPECS.has(spec)
}

// Rewrite each bare SDK import in a compiled REDUCER to the `justfiles-sdk:` sentinel the
// host resolves at spawn (a Worker has no importmap, so it can't carry a bare specifier).
// Applied only to the reducer output — the gui keeps its bare specifiers for the importmap.
// Both bundlers externalize the SDK as a bare specifier (esbuild can rewrite in-resolve but
// Bun keeps the original specifier for externals, so a post-build rewrite is the one path
// that works for both). Anchored on `from`/`import(` + an EXACT SDK-spec match, so it never
// touches a same-named string literal; the reducer's SDK imports are static today, so exact.
export function sentinelizeReducer(js: string): string {
	return js.replace(/(from\s*|import\s*\(\s*)(["'])([^"']+)\2/g, (match, pre, quote, spec) =>
		SDK_SPECS.has(spec) ? `${pre}${quote}${SDK_SENTINEL}${spec}${quote}` : match
	)
}

// The `/vendor/<spec>.js` URL a specifier resolves to (importmap value + the reducer's
// served-URL form). React keeps its existing mangled vendor names, so this is the SDK
// half of the importmap; callers merge it with the React entries.
export function vendorUrl(spec: string): string {
	return `/vendor/${spec}.js`
}
