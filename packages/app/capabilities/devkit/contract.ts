// App-facing devkit capability contract. The one privileged platform surface
// app-code uses: compile a draft from its source files, run it in a scoped
// preview kernel embedded in the caller's own window, and (later) ship it.
//
// Every method is serializable in and out — no DOM, no live objects cross the
// boundary. The host holds the toolchain + kernel natively; the app only ever
// hands over file strings and receives ids / diagnostics / zip bytes.

export interface DevkitCapability {
	// Compile + (re)mount the draft at the caller's `[data-preview-slot]`.
	// On a compile error, `diagnostics` is non-empty and the last-good preview
	// stays mounted.
	run(input: {
		slug: string
		files: Record<string, string>
	}): Promise<{ previewId: string; diagnostics: string[] }>
	// Tear down a running preview.
	stop(input: { previewId: string }): Promise<void>
	// Promote the draft to the real `/applications` (slice 5).
	install(input: { slug: string; files: Record<string, string> }): Promise<{ id: string }>
	// Emit a downloadable `.zip` of the compiled bundle (slice 5).
	pack(input: { slug: string; files: Record<string, string> }): Promise<{ zip: Uint8Array }>
}
