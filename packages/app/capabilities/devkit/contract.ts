// App-facing devkit capability contract. The one privileged platform surface
// app-code uses: compile a draft from its source files, run it in a scoped
// preview kernel embedded in the caller's own window, and (later) ship it.
//
// Every method is serializable in and out — no DOM, no live objects cross the
// boundary. The host holds the toolchain + kernel natively; the app only ever
// hands over file strings and receives ids / diagnostics / zip bytes.

// A display-only mirror of `@justfiles/app/browser`'s `Menu` — the live
// `onSelect` closures are stripped, so it stays serializable. app-code pulls
// this to render the preview's menubar itself (using the shared design CSS) and
// fires items back by position via `selectMenu`. Single-directional: the app
// asks, the host answers; the host never reaches into the app.
export type MenuItemView =
	| { separator: true }
	| { title: string; disabled?: boolean; checked?: boolean; shortcut?: string }
export type MenuView = { title: string; items: MenuItemView[] }[]

export interface DevkitCapability {
	// Compile + (re)mount the draft into the caller's preview slots.
	// On a compile error, `diagnostics` is non-empty and the last-good preview
	// stays mounted. `reset` wipes the draft's persisted state first, for a
	// clean boot (⟳ Run/Restart); omit it to keep state across rebuilds.
	run(input: {
		slug: string
		files: Record<string, string>
		reset?: boolean
	}): Promise<{ previewId: string; diagnostics: string[] }>
	// Tear down a running preview.
	stop(input: { previewId: string }): Promise<void>
	// Read the running preview's declared menubar as display structure only — the
	// live `onSelect` closures stay on the main thread and never serialize. Empty
	// before the preview mounts or when it declares no menus.
	menu(input: { previewId: string }): Promise<MenuView>
	// Fire a preview menu item by position; the host invokes its real `onSelect`
	// on the main thread, so the action runs against the live preview app.
	selectMenu(input: { previewId: string; menu: number; item: number }): Promise<void>
	// Promote the draft to the real `/applications` (slice 5).
	install(input: { slug: string; files: Record<string, string> }): Promise<{ id: string }>
	// Emit a downloadable `.zip` of the compiled bundle (slice 5).
	pack(input: { slug: string; files: Record<string, string> }): Promise<{ zip: Uint8Array }>
}
