import type { Volume } from '@justfiles/fs'
import type { TranscriptWriter, TranscriptLine } from './types.ts'
import { PATHS } from './types.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function createTranscriptWriter(vol: Volume): TranscriptWriter {
	return {
		async append(sessionId, lines) {
			const data = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
			await vol.appendFile(PATHS.transcript(sessionId), enc.encode(data))
		},

		async readLastN(sessionId, n) {
			const all = await readLines(vol, sessionId)
			return all.slice(-n)
		},

		async readAll(sessionId) {
			return readLines(vol, sessionId)
		},
	}
}

async function readLines(vol: Volume, sessionId: string): Promise<TranscriptLine[]> {
	const raw = dec.decode(await vol.readFile(PATHS.transcript(sessionId)))
	if (!raw.trim()) return []
	return raw.trim().split('\n').map(line => JSON.parse(line))
}
