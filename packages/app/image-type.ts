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

/**
 * The file in a directory that holds `of`, read and identified — or null when none of them is
 * an image this build can render. `names` is a listing, `of` is the thing a name identifies (a
 * state like `resting`, or any file name holding it), and `read` fetches one name's bytes.
 *
 * EVERY reader of a directory-of-states needs this and has to agree with the others: the
 * settings host, the frieren shell and the face generator all resolve the same avatar
 * directory, and a disagreement about which file holds `resting` is a bug you can only see by
 * comparing two screens. So it is one function, taking a reader because those three hold three
 * different volume types.
 *
 * Two rules, both there because a name is weaker than it looks:
 *
 * - SORTED, so several claimants resolve the same way everywhere. `putAvatarFile` makes
 *   `pleased.png` + `pleased.webp` unreachable through the capability, but a hand-unzipped
 *   pack or a rename in the Files app still can — and raw `readdir` is sorted on the native
 *   backend and insertion-ordered in memory, so without this those two would resolve
 *   DIFFERENTLY PER DEVICE, forever. Not a format preference (there is no reason to prefer
 *   one), just a stable order.
 * - SKIP what cannot be rendered and KEEP LOOKING. A directory may also hold `resting.txt`, a
 *   video, a half-synced file; a reader that stopped at the first same-stem name would report
 *   a whole avatar as unusable because of the file sitting next to the real one.
 */
export async function readImageFile(
	names: string[],
	of: string,
	read: (name: string) => Promise<Uint8Array>
): Promise<{ name: string; bytes: Uint8Array; type: string } | null> {
	for (const name of imageFileNames(names, of)) {
		const bytes = await read(name)
		const type = imageType(bytes)
		if (type) return { name, bytes, type }
	}
	return null
}

/**
 * The names in `names` that claim the same thing as `of`, in the order `readImageFile` tries
 * them. A WRITER needs this too: publishing one state means every other file claiming it has
 * to go, or the reader above is left arbitrating between two files that both say they are the
 * same thing. `of` is stem-matched, so a caller may pass the state or a file name holding it.
 */
export function imageFileNames(names: string[], of: string): string[] {
	return names.filter((name) => fileStem(name) === fileStem(of)).sort()
}

/**
 * The part of a name before its extension — the part that says WHICH thing this is, as opposed
 * to the extension, which claims what format it is in and is not believed by anything here.
 * One implementation, because a directory-of-states is only coherent while the writer, every
 * reader and every label agree on where that boundary falls.
 */
export function fileStem(name: string): string {
	const dot = name.lastIndexOf('.')
	return dot > 0 ? name.slice(0, dot) : name
}
