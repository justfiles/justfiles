import type { CandidateChunk } from './scoring'

export type RawEmbedding = Buffer | Uint8Array | ArrayBuffer

export interface TextChunk {
	seq: number
	text: string
	startLine: number
	endLine: number
	tokenCount: number
}

export function toFloat32Array(value: RawEmbedding | null): Float32Array {
	if (!value) return new Float32Array(0)
	if (value instanceof Float32Array) return value
	if (value instanceof ArrayBuffer) return new Float32Array(value)
	return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
}

export function genId(prefix: string): string {
	const ts = Date.now().toString(36)
	const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
	return `${prefix}_${ts}${rand}`
}

export async function sha256hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

export function normalizeText(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

export function approxTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

const BREAK_PATTERNS: Array<[RegExp, number]> = [
	[/^# /, 100],
	[/^## /, 90],
	[/^### /, 80],
	[/^#{4,}/, 60],
	[/^```/, 80],
	[/^-{3,}$/, 60],
	[/^\s*$/, 20],
	[/^[-*+] /, 5]
]

function lineBreakScore(line: string): number {
	for (const [re, score] of BREAK_PATTERNS) {
		if (re.test(line)) return score
	}
	return 1
}

export function chunkText(text: string, targetTokens = 400): TextChunk[] {
	const lines = text.split('\n')
	const chunks: TextChunk[] = []
	let seq = 0
	let i = 0

	while (i < lines.length) {
		const startLine = i
		const chunkLines: string[] = []
		let tokens = 0

		while (i < lines.length) {
			const line = lines[i]
			tokens += approxTokens(`${line}\n`)
			chunkLines.push(line)
			i++

			if (tokens >= targetTokens) {
				const window = Math.min(20, chunkLines.length - 1)
				let bestScore = 0
				let bestJ = -1

				for (let j = chunkLines.length - 1; j >= chunkLines.length - window; j--) {
					const score = lineBreakScore(chunkLines[j])
					if (score > bestScore) {
						bestScore = score
						bestJ = j
					}
				}

				if (bestScore > 1 && bestJ > 0) {
					const toReturn = chunkLines.splice(bestJ)
					i -= toReturn.length
				}

				break
			}
		}

		if (chunkLines.length > 0) {
			const chunkTextContent = chunkLines.join('\n')
			chunks.push({
				seq: seq++,
				text: chunkTextContent,
				startLine,
				endLine: startLine + chunkLines.length - 1,
				tokenCount: approxTokens(chunkTextContent)
			})
		}
	}

	return chunks
}

export function generateSnippet(text: string, query: string, maxLen = 200): string {
	const firstTerm = query.split(/\s+/)[0]?.toLowerCase() ?? ''
	const idx = firstTerm ? text.toLowerCase().indexOf(firstTerm) : -1
	const start = Math.max(0, idx === -1 ? 0 : idx - 60)
	const end = Math.min(text.length, start + maxLen)
	const snippet = text.slice(start, end)
	return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`
}

export function encodeEmbedding(values: number[]): Uint8Array {
	return new Uint8Array(new Float32Array(values).buffer)
}

export function placeholders(count: number): string {
	return Array.from({ length: count }, () => '?').join(',')
}

export function normalizeTags(tags?: string | string[]): string[] {
	if (!tags) return []
	return Array.isArray(tags) ? tags.filter(Boolean) : [tags]
}

export const STRONG_SIGNAL_MIN_SCORE = 0.85
export const STRONG_SIGNAL_MIN_GAP = 0.15

export function hasStrongExactSignal(exact: CandidateChunk[]): boolean {
	if (exact.length === 0) return false
	const top = exact[0].score
	if (top < STRONG_SIGNAL_MIN_SCORE) return false
	const second = exact[1]?.score ?? 0
	return top - second >= STRONG_SIGNAL_MIN_GAP
}
