// The `image` capability is the image-side sibling of `ai` — a single USE facet
// any app may call. It is its own capability (not a verb on `ai`) because text and
// image are separate engines with separate models everywhere underneath (pi-ai keeps
// parallel `Models`/`ImagesModels` stacks), and a provider backs each independently.
// Resolution follows the active AI account: if its provider has no image binding,
// the capability is unavailable.

// USE facet — exposed to every app via `@justfiles/app/capabilities/image`.
export interface GeneratedImage {
	// Base64-encoded bytes (pi-ai's ImageContent shape). Callers that keep images
	// around (e.g. the agent's image tool) should offload to the Volume, not store this.
	data: string
	mimeType: string
}

export interface ImageCapability {
	generateImage(input: { prompt: string }): Promise<{ images: GeneratedImage[] }>
}
