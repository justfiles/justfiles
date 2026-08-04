// Shared runtime specifier lists for app bundling.
//
// An app artifact bundles everything it uses — the platform SDK AND its UI framework —
// into `app.js`/`gui.js`. No host serves framework bytes; the only thing a host injects
// is the platform stylesheet (see frieren's `gui-channel.ts`).

// The React family. Devkit ships these as bundle-able source in the app-code sysroot
// (`buildRuntime`), so a draft's `gui.js` inlines exactly one copy. The sysroot's SDK
// modules are built with React external so they reach that same copy instead of
// inlining a second one — two Reacts is the classic "Invalid hook call". React MUST
// still stay out of a reducer-reachable SDK module: the reducer runs headless, with no
// document to render into. `buildRuntime` guards that via `sdkRuntimeSpecs.reducer`.
export const reactSpecs = [
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
// `reducer: true` = reducer-reachable, so it must stay react-free (see above).
// `@justfiles/app/react`
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

const RUNTIME_SPECS = new Set<string>([...sdkRuntimeSpecs.map((s) => s.spec), ...reactSpecs])

// Every bare specifier devkit can resolve — the SDK subpaths plus the React family.
// All of them come out of the app-code sysroot's runtime map, so this is exactly the
// set a draft may import.
export function isRuntimeSpec(spec: string): boolean {
	return RUNTIME_SPECS.has(spec)
}
