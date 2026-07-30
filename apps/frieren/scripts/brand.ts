// The brand surface both icon scripts render onto: the green field and the PNG encode.
// Shared so the avatar faces and the PWA icons can't drift apart.

// Subtle, elegant green: a brighter emerald centre fading to a deeper forest
// edge gives the flat cutout some depth without shouting.
export const CENTRE = '#4d8c69'
export const EDGE = '#2e6349'

// A smooth radial gradient balloons a truecolor PNG (the 512 was ~100 KB). These
// icons are just a few flat colours plus that gradient, so a palette quantises them
// to a third of the size; quality 96 keeps the mean per-channel error ~0.3/255 —
// visually identical, no banding. compressionLevel/effort are maxed (lossless deflate).
export const PNG = {
	palette: true,
	quality: 96,
	dither: 0.5,
	compressionLevel: 9,
	effort: 10
} as const

// How much of the canvas the artwork fills. The avatar is drawn at the same fraction as
// the square PWA icons, and the face matrix reserves the rest as the margin its
// accessories poke into.
export const AVATAR_FRAC = 0.76

export function background(size: number): Buffer {
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
			`<defs><radialGradient id="g" cx="50%" cy="42%" r="75%">` +
			`<stop offset="0%" stop-color="${CENTRE}"/>` +
			`<stop offset="100%" stop-color="${EDGE}"/>` +
			`</radialGradient></defs>` +
			`<rect width="${size}" height="${size}" fill="url(#g)"/></svg>`
	)
}
