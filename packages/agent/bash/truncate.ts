export const MAX_OUTPUT_BYTES = 50 * 1024

export interface TruncateOptions {
	maxBytes?: number
}

export interface TruncateResult {
	text: string
	truncated: boolean
	droppedBytes: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function truncateTail(input: string, options: TruncateOptions = {}): TruncateResult {
	const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES
	const buf = encoder.encode(input)
	if (buf.byteLength <= maxBytes) {
		return { text: input, truncated: false, droppedBytes: 0 }
	}
	let start = buf.byteLength - maxBytes
	while (start < buf.byteLength && ((buf[start] ?? 0) & 0xc0) === 0x80) start++
	const tail = decoder.decode(buf.subarray(start))
	const droppedBytes = start
	return {
		text: `[truncated: ${droppedBytes} bytes dropped]\n${tail}`,
		truncated: true,
		droppedBytes
	}
}
