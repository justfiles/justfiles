import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Volume } from '@justfiles/fs'
import * as paths from './paths.ts'
import { names, readText } from './sections.ts'
import { dayInTz } from './timezone.ts'
import { toEntry } from './transcript.ts'
import type { ShellRecord, TranscriptEntry } from './types.ts'

/** One line of a mirrored transcript: an entry and when it was said, as an ISO time. */
export type MirroredEntry = TranscriptEntry & { at: string }

/** Of a tool result, what the mirror keeps. */
const TOOL_TEXT_LIMIT = 2000

interface MirrorDeps {
	volume: Volume
	shellId: string
	timeZone: string
	/** The conversation's entries after `id`, or all of them, oldest first. */
	scan(after: number | undefined): AsyncIterable<EntryRecord>
}

/**
 * This shell's conversation on the Volume, a JSONL file per day, each entry appended once and
 * in order. The newest mirrored entry is read back from the files, so a reopened ghost carries
 * on where the last process stopped. `sync` runs one pass at a time; calls during a pass
 * share the one queued after it.
 */
export function createMirror({ volume, shellId, timeZone, scan }: MirrorDeps) {
	const dir = paths.shellTranscripts(shellId)
	// Read from the files by the first pass; passes run one at a time.
	let loaded = false
	let mark: number | undefined
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
			;({ mark, torn } = await newest())
			loaded = true
		}
		for await (const record of scan(mark)) {
			const entry = toEntry(record)
			if (entry !== undefined) {
				const at = new Date(record.model?.[0]?.timestamp ?? Date.now())
				const path = paths.transcript(shellId, dayInTz(at, timeZone))
				await volume.mkdir(dir, { recursive: true })
				// A line a dying process left half written ends before this one starts.
				const separator = torn === path ? '\n' : ''
				await volume.appendFile(
					path,
					encode(`${separator}${JSON.stringify(mirrored(entry, at))}\n`)
				)
				torn = undefined
			}
			mark = record.id
		}
	}

	/** The id of the newest mirrored entry, and the newest file when it ends mid-line. */
	async function newest() {
		const days = (await names(volume, dir)).filter((name) => name.endsWith('.jsonl'))
		const last = days.at(-1)
		const text = last === undefined ? undefined : await readText(volume, `${dir}/${last}`)
		const lines = text === undefined ? [] : parseLines(text)
		return {
			mark: lines.at(-1)?.id,
			torn: text === undefined || text === '' || text.endsWith('\n') ? undefined : `${dir}/${last}`
		}
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

function mirrored(entry: TranscriptEntry, at: Date): MirroredEntry {
	const line = { at: at.toISOString(), ...entry }
	if (line.kind === 'tool' && line.text.length > TOOL_TEXT_LIMIT)
		line.text = `${line.text.slice(0, TOOL_TEXT_LIMIT)}… [${line.text.length - TOOL_TEXT_LIMIT} more characters]`
	return line
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
