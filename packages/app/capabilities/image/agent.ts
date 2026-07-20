// The image capability's agent-facing tool (a Step 3.5 descriptor): generate via
// the capability, offload the bytes to the Volume, and hand back a text summary
// plus `details.images` refs. Base64 stays out of the model-facing content — a
// tool result's image blocks would ride back into model context as vision input —
// while `details` is the out-of-band channel the transcript renderer reads (#194).

import type { CapabilityTool } from '../core.ts'
import type { GeneratedImage } from './contract.ts'

export const GENERATED_IMAGES_DIR = '/Pictures'

export interface ImageRef {
	src: string
	mimeType: string
	alt?: string
}

const EXTENSION: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
}

function fromBase64(s: string): Uint8Array {
	const bin = atob(s)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return bytes
}

export const imageAgentTools: CapabilityTool[] = [
	{
		name: 'generate_image',
		description:
			'Generate an image from a text prompt and save it to the user’s files. ' +
			'Returns the saved file path(s). Use when the user asks you to draw, create, ' +
			'or show them an image of something.',
		parameters: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					description: 'What the image should depict — subject, style, mood.'
				}
			},
			required: ['prompt']
		},
		execute: async (invoke, params, { volume }) => {
			const { prompt } = params as { prompt: string }
			const { images } = (await invoke('generateImage', { prompt })) as {
				images: GeneratedImage[]
			}
			if (images.length === 0) throw new Error('the image engine returned no image')
			await volume.mkdir(GENERATED_IMAGES_DIR, { recursive: true })
			const refs: ImageRef[] = []
			for (const image of images) {
				const ext = EXTENSION[image.mimeType] ?? 'png'
				const src = `${GENERATED_IMAGES_DIR}/${crypto.randomUUID().slice(0, 8)}.${ext}`
				await volume.writeFile(src, fromBase64(image.data))
				refs.push({ src, mimeType: image.mimeType, alt: prompt })
			}
			const paths = refs.map((r) => r.src).join(', ')
			return {
				content: `Generated ${refs.length === 1 ? 'an image' : `${refs.length} images`} and saved to ${paths}. The user can open it from their files.`,
				details: { images: refs }
			}
		}
	}
]
