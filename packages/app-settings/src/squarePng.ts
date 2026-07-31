// Any image the user drops or picks into the one shape the volume stores an avatar in:
// a centre-cropped 256² PNG. A copy of the shell's `src/agent/squarePng.ts` on purpose —
// this runs inside the app frame, which shares no module with the shell.
export async function squarePng(source: string): Promise<Uint8Array<ArrayBuffer>> {
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
			'image/png'
		)
	)
	return new Uint8Array(await blob.arrayBuffer())
}

/** Bytes off the volume → a `blob:` URL the frame's CSP allows as an image source. */
export function pngUrl(bytes: Uint8Array): string {
	return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
}
