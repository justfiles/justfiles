// Any image (a face the image engine returned at ~1024px) into the one shape the profile
// stores an avatar in: a centre-cropped 256² PNG. Used by the lazy face pipeline
// (./faces.ts). Settings' Agent pane has its own copy — it runs in an app frame and
// shares no module with the shell.
export async function squarePng(source: string): Promise<Uint8Array> {
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
			(value) => (value ? resolve(value) : reject(new Error('Could not create avatar'))),
			'image/png'
		)
	)
	return new Uint8Array(await blob.arrayBuffer())
}
