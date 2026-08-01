import { imageType } from '@justfiles/app/image-type'

// Any image the user drops or picks into the one shape the volume stores an avatar state in:
// a centre-cropped 256² square, in the best format this browser will encode. A copy of the
// shell's `src/agent/squareImage.ts` on purpose — this runs inside the app frame, which shares
// no module with the shell.
//
// WEBP IF THE BROWSER CAN, PNG IF IT CANNOT, and the caller names the file after what it got.
// At 256² a photo is ~26 KB as WebP against ~164 KB as canvas PNG, and every one of those
// bytes replicates to each device (and again for each face derived from it). `toBlob` falls
// back to PNG on its own when a type is unsupported — Safari has no WebP encoder — and
// `blob.type` says which happened, so there is no feature detection here and no branch: ask
// for the good one, report what came back. Nothing downstream cares, because a state's format
// is read from its bytes and never from its name.
const WANT = 'image/webp'
const QUALITY = 0.9

export async function squareImage(
	source: string
): Promise<{ bytes: Uint8Array<ArrayBuffer>; ext: string }> {
	const image = new Image()
	image.src = source
	await image.decode()
	const size = Math.min(image.naturalWidth, image.naturalHeight)
	const x = (image.naturalWidth - size) / 2
	const y = (image.naturalHeight - size) / 2
	const canvas = document.createElement('canvas')
	canvas.width = 256
	canvas.height = 256
	canvas.getContext('2d')?.drawImage(image, x, y, size, size, 0, 0, 256, 256)
	const blob = await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(
			(value) => (value ? resolve(value) : reject(new Error('Could not read that image'))),
			WANT,
			QUALITY
		)
	)
	return {
		bytes: new Uint8Array(await blob.arrayBuffer()),
		// `image/webp` or the `image/png` the spec falls back to — the subtype IS the extension
		// for both, so there is no table to keep.
		ext: blob.type.slice(blob.type.indexOf('/') + 1)
	}
}

/**
 * Bytes → a `blob:` URL the frame's CSP allows as an image source, typed by what the bytes
 * actually are. Used for a photo the user just picked, before it is on the volume.
 */
export function imageUrl(bytes: Uint8Array): string {
	return URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageType(bytes) ?? '' }))
}
