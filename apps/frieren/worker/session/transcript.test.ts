import { describe, it, expect } from 'bun:test'
import { memStorage } from '@justfiles/fs/storage/mem'
import { volume } from '@justfiles/fs'
import { createTranscriptWriter } from './transcript.ts'
import { PATHS } from './types.ts'
import type { TranscriptLine } from './types.ts'

function setup() {
	const vol = volume(memStorage())
	const writer = createTranscriptWriter(vol)
	return { vol, writer }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const SESSION_ID = '2026-04-12T09-20-31Z_f83a'

describe('TranscriptWriter', () => {
	it('append user turn → JSONL line with ts, role, content', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		const line: TranscriptLine = { ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' }
		await writer.append(SESSION_ID, [line])

		const raw = dec.decode(await vol.readFile(PATHS.transcript(SESSION_ID)))
		const parsed = JSON.parse(raw.trim())
		expect(parsed).toEqual(line)
	})

	it('append assistant turn → JSONL line', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		const line: TranscriptLine = { ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'hi there' }
		await writer.append(SESSION_ID, [line])

		const raw = dec.decode(await vol.readFile(PATHS.transcript(SESSION_ID)))
		const parsed = JSON.parse(raw.trim())
		expect(parsed).toEqual(line)
	})

	it('append tool_call → JSONL line with tool_name + input', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		const line: TranscriptLine = {
			ts: '2026-04-12T09:20:36Z',
			role: 'tool_call',
			tool_name: 'read_file',
			input: { path: '/soul.md' },
		}
		await writer.append(SESSION_ID, [line])

		const raw = dec.decode(await vol.readFile(PATHS.transcript(SESSION_ID)))
		const parsed = JSON.parse(raw.trim())
		expect(parsed).toEqual(line)
	})

	it('append tool_result → JSONL line with tool_name + content (stringified)', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		const line: TranscriptLine = {
			ts: '2026-04-12T09:20:37Z',
			role: 'tool_result',
			tool_name: 'read_file',
			content: 'file contents here',
		}
		await writer.append(SESSION_ID, [line])

		const raw = dec.decode(await vol.readFile(PATHS.transcript(SESSION_ID)))
		const parsed = JSON.parse(raw.trim())
		expect(parsed).toEqual(line)
	})

	it('appends multiple lines as separate JSONL entries', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		const lines: TranscriptLine[] = [
			{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' },
			{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'hi' },
		]
		await writer.append(SESSION_ID, lines)

		const raw = dec.decode(await vol.readFile(PATHS.transcript(SESSION_ID)))
		const parsed = raw.trim().split('\n').map(l => JSON.parse(l))
		expect(parsed).toEqual(lines)
	})

	it('readLastN(20) returns last 20 lines in order', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		// Write 25 lines
		const lines: TranscriptLine[] = []
		for (let i = 0; i < 25; i++) {
			lines.push({ ts: `2026-04-12T09:${String(i).padStart(2, '0')}:00Z`, role: 'user', content: `msg ${i}` })
		}
		await writer.append(SESSION_ID, lines)

		const last20 = await writer.readLastN(SESSION_ID, 20)
		expect(last20).toHaveLength(20)
		expect(last20[0]).toEqual(lines[5])
		expect(last20[19]).toEqual(lines[24])
	})

	it('readLastN(20) on transcript with 5 lines returns all 5', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		const lines: TranscriptLine[] = []
		for (let i = 0; i < 5; i++) {
			lines.push({ ts: `2026-04-12T09:${String(i).padStart(2, '0')}:00Z`, role: 'user', content: `msg ${i}` })
		}
		await writer.append(SESSION_ID, lines)

		const result = await writer.readLastN(SESSION_ID, 20)
		expect(result).toHaveLength(5)
		expect(result).toEqual(lines)
	})

	it('readAll returns all lines', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		const lines: TranscriptLine[] = [
			{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' },
			{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'hi' },
		]
		await writer.append(SESSION_ID, lines)

		const all = await writer.readAll(SESSION_ID)
		expect(all).toEqual(lines)
	})

	it('append to existing transcript preserves prior lines', async () => {
		const { vol, writer } = setup()
		await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
		await vol.writeFile(PATHS.transcript(SESSION_ID), enc.encode(''))

		await writer.append(SESSION_ID, [
			{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'first' },
		])
		await writer.append(SESSION_ID, [
			{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'second' },
		])

		const all = await writer.readAll(SESSION_ID)
		expect(all).toHaveLength(2)
		expect(all[0]!.role === 'user' && all[0]!.content).toBe('first')
		expect(all[1]!.role === 'assistant' && all[1]!.content).toBe('second')
	})
})
