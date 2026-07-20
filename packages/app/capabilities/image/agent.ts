// The image capability's agent tools, derived from the contract metadata via
// `implementTool`. Only the judgment is spelled out here: a friendlier tool name
// and an execute that offloads the bytes to the Volume — base64 must never enter
// the model-facing content (a tool result's image blocks would ride back into
// model context as vision input), while `details.images` is the out-of-band
// channel the transcript renderer reads (#194).

import { implementTool } from '../core.ts'
import { image } from './contract.ts'

export const GENERATED_IMAGES_DIR = '/pictures'

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

export const imageAgentTools = implementTool(image, {
	generateImage: {
		name: 'generate_image',
		execute: async (invoke, { prompt }, { volume }) => {
			const { images } = await invoke('generateImage', { prompt })
			if (images.length === 0) throw new Error('the image engine returned no image')
			await volume.mkdir(GENERATED_IMAGES_DIR, { recursive: true })
			const refs: ImageRef[] = []
			for (const generated of images) {
				const ext = EXTENSION[generated.mimeType] ?? 'png'
				const src = `${GENERATED_IMAGES_DIR}/${crypto.randomUUID().slice(0, 8)}.${ext}`
				await volume.writeFile(src, fromBase64(generated.data))
				refs.push({ src, mimeType: generated.mimeType, alt: prompt })
			}
			const paths = refs.map((r) => r.src).join(', ')
			return {
				content: `Generated ${refs.length === 1 ? 'an image' : `${refs.length} images`} and saved to ${paths}. The user can open it from their files.`,
				details: { images: refs }
			}
		}
	}
})
