/**
 * A ZIP reader for archives we did not create.
 *
 * `@justfiles/app`'s `bundleFromZip` exists and is deliberately not used here:
 * it calls fflate's `unzipSync`, which inflates every entry into memory at once.
 * That is correct for a devkit draft and is precisely the decompression-bomb
 * hole for a stranger's release. Here nothing is inflated until it is asked for,
 * and nothing is inflated past a caller-supplied bound.
 *
 * The central directory sits at the END of a ZIP, so there is no forward-only
 * parse: the archive arrives whole and is indexed backwards. `DecompressionStream`
 * cannot read ZIP at all — it is a container, not a codec — so this walks the
 * directory itself and hands each entry's payload to `deflate-raw`, keeping the
 * inflate native.
 */

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** The largest trailing comment a ZIP may carry, and so how far back EOCD can sit. */
const COMMENT_MAX = 0xffff

export interface ZipEntry {
	name: string
	/** 0 stored, 8 deflate. Anything else is refused when it is read. */
	method: number
	/** Where the payload starts and ends, resolved through the local header. */
	start: number
	end: number
	/**
	 * The uncompressed size the archive DECLARES. Recorded for reporting and
	 * never used as a bound — see `inflate`.
	 */
	size: number
	/** The Unix mode, or 0 from a zipper that records none. */
	mode: number
}

/** Every entry, indexed but not read. */
export function entries(archive: Uint8Array): ZipEntry[] {
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
	const at = (p: number) => view.getUint32(p, true)
	const at16 = (p: number) => view.getUint16(p, true)

	// Scan back for the end-of-central-directory record. It is 22 bytes plus a
	// comment of unknown length, so its position can only be found, not computed.
	let eocd = -1
	for (let p = archive.length - 22; p >= Math.max(0, archive.length - 22 - COMMENT_MAX); p--) {
		if (at(p) === EOCD) {
			eocd = p
			break
		}
	}
	if (eocd < 0) throw new Error('zip: not an archive')

	const count = at16(eocd + 10)
	const offset = at(eocd + 16)
	// Every ZIP64 field is signalled by its 32-bit slot being saturated. Refusing
	// is safe here because nothing legitimate reaches 4 GB inside our size caps.
	if (count === 0xffff || offset === 0xffffffff) throw new Error('zip: zip64 unsupported')

	const found: ZipEntry[] = []
	let p = offset
	for (let i = 0; i < count; i++) {
		if (p + 46 > archive.length || at(p) !== CENTRAL) throw new Error('zip: bad central directory')

		const nameLength = at16(p + 28)
		const name = new TextDecoder().decode(archive.subarray(p + 46, p + 46 + nameLength))
		const compressed = at(p + 20)
		const local = at(p + 42)

		// Bit 0 of the general-purpose flags. An encrypted entry would inflate to
		// garbage rather than fail, so it has to be caught by name.
		if (at16(p + 8) & 1) throw new Error(`zip: ${name}: encrypted`)
		if (compressed === 0xffffffff || local === 0xffffffff)
			throw new Error(`zip: ${name}: zip64 unsupported`)

		// The local header repeats the name and extra field at LENGTHS OF ITS OWN,
		// which are allowed to differ from the central directory's. Computing the
		// payload offset from the wrong copy is a classic way to read the wrong bytes.
		if (local + 30 > archive.length || at(local) !== LOCAL)
			throw new Error(`zip: ${name}: bad local header`)
		const start = local + 30 + at16(local + 26) + at16(local + 28)
		const end = start + compressed
		if (end > archive.length) throw new Error(`zip: ${name}: truncated`)

		found.push({
			name,
			method: at16(p + 10),
			start,
			end,
			size: at(p + 24),
			mode: at(p + 38) >>> 16
		})
		p += 46 + nameLength + at16(p + 30) + at16(p + 32)
	}
	return found
}

/** One entry's bytes, refusing to produce more than `limit` of them. */
export async function inflate(
	archive: Uint8Array,
	entry: ZipEntry,
	limit: number
): Promise<Uint8Array> {
	const raw = archive.subarray(entry.start, entry.end)

	// Stored. The cap still applies — an uncompressed entry can be as large as the
	// archive, and "no compression" is not "no bound".
	if (entry.method === 0) {
		if (raw.length > limit) throw new Error(`${entry.name}: over ${limit} bytes`)
		return raw
	}
	if (entry.method !== 8) throw new Error(`zip: ${entry.name}: compression method ${entry.method}`)

	const source = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(raw)
			c.close()
		}
	})
	return readCapped(source.pipeThrough(new DecompressionStream('deflate-raw')), limit, entry.name)
}

/**
 * Read a stream, refusing to hold more than `limit` bytes of it.
 *
 * The bomb defence, and the reason it is a running count rather than a check
 * against a declared size: every length a ZIP carries is written by whoever
 * built it. Cancelling the reader stops the inflate through backpressure, so an
 * archive that expands to a gigabyte costs us `limit` and one abort.
 *
 * Also how the archive itself is fetched, where the untrusted number is
 * `Content-Length`.
 */
export async function readCapped(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	what: string
): Promise<Uint8Array> {
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > limit) {
			await reader.cancel()
			throw new Error(`${what}: over ${limit} bytes`)
		}
		chunks.push(value)
	}

	const out = new Uint8Array(total)
	let at = 0
	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.byteLength
	}
	return out
}
