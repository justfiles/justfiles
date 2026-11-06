import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Volume } from '@justfiles/fs'
import * as paths from './paths.ts'
import { names, readText } from './sections.ts'
import { dayInTz } from './timezone.ts'
import { toEntry } from './transcript.ts'
import type { ShellRecord, TranscriptEntry } from './types.ts'

/**
 * One line of a mirrored transcript: an entry and when it was said, as an ISO time. The
 * transcript is what syncs to every shell, so it is digest-grade: a tool call is kept as its
 * name and the head of its input, and a tool result not at all. Tool results are the bulk of
 * a conversation and where secrets pass through; the asks, the answers and the tool names
 * recall it as well.
 */
export type MirroredEntry = (
	| Exclude<TranscriptEntry, { kind: 'assistant' | 'tool' }>
	| {
			id: number
			kind: 'assistant'
			text: string
			toolCalls: { id: string; name: string; input: string }[]
			error?: string
	  }
) & { at: string }

/** Of a tool call's input, as JSON, what the mirror keeps. */
const INPUT_LIMIT = 120

interface MirrorDeps {
	volume: Volume
	shellId: string
	timeZone: string
	/** The conversation's entries after `id`, or all of them, oldest first. */
	scan(after: number | undefined): AsyncIterable<EntryRecord>
}

/**
 * This shell's conversation on the Volume, a JSONL file per day, each entry appended once and
 * in order. An entry goes to the day it was said, or to the newest file's day when that is
 * later (an entry without a time, a changed time zone), so the newest file always holds the
 * newest entry. That is read back at open, and a reopened ghost carries on from it. `sync` runs one pass at a time; calls during a pass
 * share the one queued after it.
 */
export function createMirror({ volume, shellId, timeZone, scan }: MirrorDeps) {
	const dir = paths.shellTranscripts(shellId)
	// Read from the files by the first pass; passes run one at a time.
	let loaded = false
	let mark: number | undefined
	let day: string | undefined
	let torn: string | undefined
	let chain: Promise<void> = Promise.resolve()
	let queued = false
	let stopped = false
	return { sync, stop }

	/** No pass starts after this; resolves when the running one ends. */
	function stop(): Promise<void> {
		stopped = true
		return chain
	}

	function sync(): Promise<void> {
		if (!queued && !stopped) {
			queued = true
			chain = chain
				.then(() => {
					queued = false
					return stopped ? undefined : pass()
				})
				// A failed pass leaves the mark where it was; the next one tries again from there.
				.catch(() => {})
		}
		return chain
	}

	async function pass(): Promise<void> {
		if (!loaded) {
			;({ mark, day, torn } = await newest())
			loaded = true
		}
		for await (const record of scan(mark)) {
			const entry = toEntry(record)
			if (entry !== undefined && entry.kind !== 'tool') {
				const at = new Date(entry.at ?? Date.now())
				const said = dayInTz(at, timeZone)
				if (day === undefined || said > day) day = said
				const path = paths.transcript(shellId, day)
				await volume.mkdir(dir, { recursive: true })
				// A line a dying process left half written ends before this one starts.
				const separator = torn === path ? '\n' : ''
				await volume.appendFile(
					path,
					encode(`${separator}${JSON.stringify(mirrored(entry, at))}\n`)
				)
				if (separator !== '') torn = undefined
			}
			mark = record.id
		}
	}

	/**
	 * The id of the newest mirrored entry, from the newest file that holds one; the newest
	 * file's day; and that file when it ends mid-line.
	 */
	async function newest() {
		const days = (await names(volume, dir)).filter((name) => name.endsWith('.jsonl'))
		const last = days.at(-1)
		let mark: number | undefined
		let torn: string | undefined
		for (const day of [...days].reverse()) {
			const path = `${dir}/${day}`
			const text = (await readText(volume, path)) ?? ''
			if (day === last && text !== '' && !text.endsWith('\n')) torn = path
			mark = parseLines(text).at(-1)?.id
			if (mark !== undefined) break
		}
		return { mark, day: last?.slice(0, -'.jsonl'.length), torn }
	}
}

/** The entries of one transcript file; a line that does not parse is skipped. */
export function parseLines(text: string): MirroredEntry[] {
	const entries: MirroredEntry[] = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			const entry = JSON.parse(line)
			if (typeof entry?.id === 'number' && typeof entry.at === 'string') entries.push(entry)
		} catch {}
	}
	return entries
}

function mirrored(entry: Exclude<TranscriptEntry, { kind: 'tool' }>, at: Date): MirroredEntry {
	if (entry.kind !== 'assistant') return { at: at.toISOString(), ...entry }
	const toolCalls = entry.toolCalls.map(({ id, name, args }) => {
		const input = JSON.stringify(args) ?? ''
		return {
			id,
			name,
			input: input.length > INPUT_LIMIT ? `${input.slice(0, INPUT_LIMIT)}…` : input
		}
	})
	return { at: at.toISOString(), ...entry, toolCalls }
}

/** Write this shell's record: who it is, the tools it has, and now as when it was last seen. */
export async function writeShellRecord(
	volume: Volume,
	shell: ShellRecord,
	capabilities: readonly string[]
): Promise<void> {
	await volume.mkdir(paths.shellsDir(), { recursive: true })
	const record = { ...shell, capabilities, lastSeen: new Date().toISOString() }
	await volume.writeFile(
		paths.shellFile(shell.id),
		encode(`${JSON.stringify(record, null, '\t')}\n`)
	)
}

const encode = (text: string) => new TextEncoder().encode(text)
