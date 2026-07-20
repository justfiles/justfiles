// The `image` capability is the image-side sibling of `ai` — a single USE facet
// any app may call. It is its own capability (not a verb on `ai`) because text and
// image are separate engines with separate models everywhere underneath (pi-ai keeps
// parallel `Models`/`ImagesModels` stacks), and a provider backs each independently.
// Resolution follows the active AI account: if its provider has no image binding,
// the capability is unavailable.

import { defineCapability } from '../core.ts'

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

// The factory lives here (not index.ts) so agent.ts can import it without a
// module cycle. The metadata is the contract's runtime twin: `implementTool`
// derives the agent tool's schema and description from it.
export const image = defineCapability<'image', ImageCapability>('image', {
	generateImage: {
		description:
			'Generate an image from a text prompt and save it to the user’s files. ' +
			'Returns the saved file path(s). Use when the user asks you to draw, create, ' +
			'or show them an image of something.',
		input: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					description: 'What the image should depict — subject, style, mood.'
				}
			},
			required: ['prompt']
		}
	}
})
