// Any image (a face the image engine returned at ~1024px) into the one shape the volume stores
// an avatar state in: a centre-cropped 256² square, in the best format this browser will
// encode. Used by the lazy face pipeline (./faces.ts). Settings' Agent pane has its own copy —
// it runs in an app frame and shares no module with the shell.
//
// WEBP IF THE BROWSER CAN, PNG IF IT CANNOT, and the caller is never told which. At 256² a
// photo is ~26 KB as WebP against ~164 KB as canvas PNG, and every one of those bytes
// replicates to each device (and again for each derived face). `toBlob` falls back to PNG on
// its own when a type is unsupported — Safari has no WebP encoder — so there is no feature
// detection here and no branch: ask for the good one, keep the bytes. Which one came back is
// not a fact anything downstream needs; a state's format is read from its bytes, and its file
// is named for the state, so reporting the encoder would only invite someone to name a file
// after it (see the settings host's `putAvatarFile`).
const WANT = 'image/webp'
const QUALITY = 0.9

export async function squareImage(source: string): Promise<Uint8Array<ArrayBuffer>> {
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
			WANT,
			QUALITY
		)
	)
	return new Uint8Array(await blob.arrayBuffer())
}
