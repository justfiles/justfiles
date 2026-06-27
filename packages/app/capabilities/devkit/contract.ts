// App-facing devkit capability contract. The one privileged platform surface
// app-code uses: compile a draft, run it in a scoped preview kernel embedded in
// the caller's own window, and ship it.
//
// A devkit project is a directory in the caller's own data dir: source under
// `projects/<slug>/src` and an optional `icon` file beside it. The caller only
// ever names the project by `slug`; devkit reads the tree off disk itself, so
// no file bytes cross the worker boundary. Every method is serializable in and
// out — the app exchanges a slug and receives ids / diagnostics / zip bytes.

import type { CheckResult, CompileResult } from './toolchain.ts'

// A display-only mirror of `@justfiles/app/browser`'s `Menu` — the live
// `onSelect` closures are stripped, so it stays serializable. app-code pulls
// this to render the preview's menubar itself (using the shared design CSS) and
// fires items back by position via `selectMenu`. Single-directional: the app
// asks, the host answers; the host never reaches into the app.
export type MenuItemView =
	| { separator: true }
	| { title: string; disabled?: boolean; checked?: boolean; shortcut?: string }
export type MenuView = { title: string; items: MenuItemView[] }[]

// Host-owned preview presentation. Quay returns a URL that app-code embeds in its
// preview slot; Frieren mounts the preview itself and returns nothing.
export type DevkitPreview = { kind: 'url'; src: string }

export interface DevkitCapability {
	// ── toolchain (server / backend) ───────────────────────────────────────────
	// Bundle the named project, returning the structured `CompileResult`
	// (outputs + diagnostics). The host reads the source tree itself; the caller
	// only names the project.
	compile(input: { slug: string }): Promise<CompileResult>
	// Type-check the named project, returning diagnostics only. Degrades to
	// CAPABILITY_UNAVAILABLE on hosts without a type checker (browser/desktop).
	typecheck(input: { slug: string }): Promise<CheckResult>

	// ── preview (client, browser only) ──────────────────────────────────────
	// Compile the named project + (re)mount it into the caller's preview slots.
	// On a compile error, `diagnostics` is non-empty and the last-good preview
	// stays mounted. `reset` wipes the draft's persisted state first, for a
	// clean boot (⟳ Run/Restart); omit it to keep state across rebuilds.
	run(input: {
		slug: string
		reset?: boolean
	}): Promise<{ previewId: string; diagnostics: string[]; preview?: DevkitPreview }>
	// Tear down a running preview.
	stop(input: { previewId: string }): Promise<void>
	// Read the running preview's declared menubar as display structure only — the
	// live `onSelect` closures stay on the main thread and never serialize. Empty
	// before the preview mounts or when it declares no menus.
	menu(input: { previewId: string }): Promise<MenuView>
	// Fire a preview menu item by position; the host invokes its real `onSelect`
	// on the main thread, so the action runs against the live preview app.
	selectMenu(input: { previewId: string; menu: number; item: number }): Promise<void>
	// Promote the named project to the real `/applications` as a standalone app.
	// Compiles fresh and rejects a colliding id (check-first guard) — install only
	// creates, never overwrites. The project's `icon`, if any, is bundled so the
	// app shows its icon in the launcher. Returns the installed id.
	install(input: { slug: string }): Promise<{ id: string }>
	// Compile and emit a `.zip` of the bundle (`manifest.json` + `app.js` +
	// `gui.js` + optional `icon`), importable through the launcher's existing zip
	// path.
	pack(input: { slug: string }): Promise<{ zip: Uint8Array }>
}
