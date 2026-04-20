import type { Volume } from '@justfiles/fs'
import { file } from './file'
import {
	type CompactionEntry,
	type ContextMessage,
	type EntryId,
	type SessionEntry,
	SessionEntrySchema,
	type SessionManager
} from './session.manager'

function entryId(): EntryId {
	const bytes = new Uint8Array(4)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function walkBranch(entries: SessionEntry[], leafId: EntryId | null): SessionEntry[] {
	if (!leafId) return []
	const byId = new Map(entries.map((e) => [e.id, e]))
	const branch: SessionEntry[] = []
	let cur = leafId
	while (cur) {
		const entry = byId.get(cur)
		if (!entry) break
		branch.push(entry)
		cur = entry.parentId!
	}
	branch.reverse()
	return branch
}

export function session(path: string, volume: Volume): SessionManager {
	const sessionFile = file(volume, path)
	let activeLeafId: EntryId | null = null
	let initialized = false

	async function init(): Promise<void> {
		if (initialized) return
		initialized = true
		const entries = await sessionFile.jsonl(SessionEntrySchema)
		if (entries.length > 0) {
			activeLeafId = entries[entries.length - 1].id
		}
	}

	async function appendEntries(entries: SessionEntry[]): Promise<void> {
		const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
		await sessionFile.append(lines)
	}

	const mgr: SessionManager = {
		sessionId: crypto.randomUUID(),
		get activeLeafId() {
			return activeLeafId
		},

		async append(payloads) {
			await init()

			const now = new Date().toISOString()
			const newEntries: SessionEntry[] = []
			let parentId = activeLeafId

			for (const p of payloads) {
				const entry = { ...p, id: entryId(), parentId, ts: now } as SessionEntry
				newEntries.push(entry)
				parentId = entry.id
			}

			await appendEntries(newEntries)
			activeLeafId = newEntries[newEntries.length - 1].id
			return { compacted: false }
		},

		async buildSessionContext() {
			await init()
			const all = await sessionFile.jsonl(SessionEntrySchema)
			const branch = walkBranch(all, activeLeafId)
			const messages: ContextMessage[] = []

			let startIdx = 0
			for (let i = branch.length - 1; i >= 0; i--) {
				if (branch[i].type === 'compaction') {
					const c = branch[i] as CompactionEntry
					messages.push({ role: 'assistant', content: c.summary, timestamp: Date.parse(c.ts) })
					const keptIdx = branch.findIndex((e) => e.id === c.firstKeptEntryId)
					startIdx = keptIdx >= 0 ? keptIdx : i + 1
					break
				}
			}

			for (let i = startIdx; i < branch.length; i++) {
				const e = branch[i]
				if (e.type !== 'message') continue
				if (e.role === 'user')
					messages.push({ role: 'user', content: e.content, timestamp: Date.parse(e.ts) })
				else if (e.role === 'assistant')
					messages.push({ role: 'assistant', content: e.content, timestamp: Date.parse(e.ts) })
			}

			return messages
		},

		async walkActiveBranch() {
			await init()
			const all = await sessionFile.jsonl(SessionEntrySchema)
			return walkBranch(all, activeLeafId)
		},
		branch() {
			throw new Error('not implemented')
		},
		branchWithSummary() {
			throw new Error('not implemented')
		},
		fork() {
			throw new Error('not implemented')
		}
	}

	return mgr
}
