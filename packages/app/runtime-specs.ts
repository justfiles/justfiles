// The bare specifiers an app-code draft may import.
//
// An app artifact bundles everything it uses into `app.js`/`gui.js`. No host serves
// framework bytes; the only thing a host injects is the platform stylesheet (see
// Frieren's `gui-frame.ts`). A draft gets the platform SDK and nothing else — its
// GUI is plain DOM through `defineGUI`. An author who wants React (or anything else
// off npm) uses `packages/create-app`, where the app's own bundler inlines it.

// The platform SDK + valibot modules app-code ships in its `devkit/runtime/**` sysroot.
// Hosts load those bytes and feed them to devkit compilers as bundle-able source, so SDK
// imports are inlined into draft `app.js`/`gui.js` with no node_modules or package links.
//
// This list must enumerate every SDK subpath app-code may import so the virtual devkit
// resolver can map it to bundled runtime source. `devkit` (Code) and `settings` (Settings)
// are gated at the host, but their client factories are imported by those apps, so they're
// present like the rest; the grant is enforced on invocation, never on import.
export const sdkRuntimeSpecs: readonly string[] = [
	'@justfiles/app',
	'@justfiles/app/browser',
	'@justfiles/app/capabilities/volume',
	'@justfiles/app/capabilities/notify',
	'@justfiles/app/capabilities/email',
	'@justfiles/app/capabilities/calendar',
	'@justfiles/app/capabilities/ai',
	'@justfiles/app/capabilities/devkit',
	'@justfiles/app/capabilities/settings',
	'valibot'
]
