// Shared runtime specifier lists for app bundling.
//
// App artifacts bundle the platform SDK into `app.js`/`gui.js`. React is the one
// runtime external so every GUI shares the host document's React singleton.

// React family. Externalized in GUI builds and devkit GUI output — the host importmap
// resolves bare React specifiers to the shared React instance. A reducer worker has no
// importmap, so React MUST NOT appear in a reducer-reachable SDK module; `buildRuntime`
// guards that via `sdkRuntimeSpecs.reducer`.
export const reactExternals = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

// The platform SDK + valibot modules app-code ships in its `devkit/runtime/**` sysroot.
// Hosts load those bytes and feed them to devkit compilers as bundle-able source, so SDK
// imports are inlined into draft `app.js`/`gui.js` with no node_modules or package links.
//
// `reducer: true` = reducer-reachable, so it must stay react-free. `@justfiles/app/react`
// (the React GUI entry) and `@justfiles/app/browser` (the `defineGUI` host bindings) are
// GUI-only and may pull React, so they're `reducer: false` and excluded from the guard.
//
// This list must enumerate every SDK subpath app-code may import so the virtual devkit
// resolver can map it to bundled runtime source. `devkit` (Code) and `settings` (Settings)
// are gated at the host, but their client factories are imported by those apps, so they're
// present like the rest; the grant is enforced on invocation, never on import.
export const sdkRuntimeSpecs: readonly { spec: string; reducer: boolean }[] = [
	{ spec: '@justfiles/app', reducer: true },
	{ spec: '@justfiles/app/react', reducer: false },
	{ spec: '@justfiles/app/browser', reducer: false },
	{ spec: '@justfiles/app/capabilities/volume', reducer: true },
	{ spec: '@justfiles/app/capabilities/notify', reducer: true },
	{ spec: '@justfiles/app/capabilities/email', reducer: true },
	{ spec: '@justfiles/app/capabilities/calendar', reducer: true },
	{ spec: '@justfiles/app/capabilities/ai', reducer: true },
	{ spec: '@justfiles/app/capabilities/devkit', reducer: true },
	{ spec: '@justfiles/app/capabilities/settings', reducer: true },
	{ spec: 'valibot', reducer: true }
]

const SDK_SPECS = new Set(sdkRuntimeSpecs.map((s) => s.spec))

// Is `spec` a platform SDK specifier? Devkit bundles these from the app-code sysroot.
// React is handled separately via the bundler's top-level `external`, so it's
// deliberately not in this set.
export function isSdkSpec(spec: string): boolean {
	return SDK_SPECS.has(spec)
}
