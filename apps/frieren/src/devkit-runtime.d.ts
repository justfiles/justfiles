declare module 'virtual:devkit-runtime' {
	// Pre-bundled system libraries the devkit compiler injects into drafts,
	// keyed by import specifier (e.g. `@justfiles/app`). See devkit-runtime.ts.
	export const runtime: Record<string, string>
}
