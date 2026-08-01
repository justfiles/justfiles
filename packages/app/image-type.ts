// What an image IS, read from its own bytes.
//
// Nothing on the volume may be trusted to say its own format in its name: an avatar's file
// is named for the STATE it holds (`resting.png` is a state, not a promise about an encoder),
// a user can rename a file in the Files app, an artist's pack can ship whatever its tools
// emitted, and our own image engine "sometimes answers JPEG" when asked for PNG. A name is a
// claim; the first bytes are a fact. This is the same reason the web sniffs
// (https://mimesniff.spec.whatwg.org) rather than believing `Content-Type`.
//
// It lives in `@justfiles/app` because that is the lowest layer every consumer shares: the
// `settings` capability's host (right here), the frieren shell, its worker, and the Settings
// app frame. `@justfiles/agent` depends on this package and not the other way round, which is
// also why `IDENTITY_PATHS` is injected rather than imported.
//
// The patterns are mimesniff's image set plus AVIF/HEIC (an `ftyp` brand) and SVG. An
// UNRECOGNISED file is `null`, never a guess: a caller then treats that state as one it
// cannot render, which is a better failure than an <img> pointed at a lie.

const ASCII = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

const starts = (bytes: Uint8Array, pattern: number[], at = 0): boolean =>
	pattern.every((byte, i) => bytes[at + i] === byte)

export function imageType(bytes: Uint8Array): string | null {
	if (starts(bytes, [0x89, ...ASCII('PNG'), 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
	if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
	if (starts(bytes, ASCII('GIF8'))) return 'image/gif'
	if (starts(bytes, ASCII('RIFF')) && starts(bytes, ASCII('WEBP'), 8)) return 'image/webp'
	if (starts(bytes, ASCII('BM'))) return 'image/bmp'
	if (starts(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/vnd.microsoft.icon'
	// ISO-BMFF: the brand at byte 8 says which of the family it is.
	if (starts(bytes, ASCII('ftyp'), 4)) {
		const brand = String.fromCharCode(...bytes.slice(8, 12))
		if (brand === 'avif' || brand === 'avis') return 'image/avif'
		if (['heic', 'heix', 'hevc', 'hevx', 'mif1'].includes(brand)) return 'image/heic'
		return null
	}
	// SVG is text, so it is sniffed by its root element rather than a magic number. Safe to
	// hand to an <img>, which is the only place these URLs go: an image context runs no
	// script and fetches nothing.
	const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart()
	if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
		return 'image/svg+xml'
	}
	return null
}

/**
 * These bytes as a `data:` URL, typed by what they are — or null when they are not an image
 * this build knows. A data URL and not a `blob:` one because these travel: into React state,
 * and across the app-frame boundary whose CSP allows `data:`. Nothing has to own a revoke.
 */
export function imageDataUrl(bytes: Uint8Array): string | null {
	const type = imageType(bytes)
	if (!type) return null
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return `data:${type};base64,${btoa(binary)}`
}
