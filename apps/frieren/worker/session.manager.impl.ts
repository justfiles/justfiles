import type { Volume } from '@justfiles/fs'
import { file } from './file'
import {
	SessionEntrySchema,
	type EntryId,
	type MessageEntry,
	type SessionEntry,
	type CompactionEntry,
	type SessionManager,
	type ContextMessage,
} from './session.manager'
import type { GenerateText } from './llm.text'

const DEFAULT_CONTEXT_BUDGET = 100_000
const CHARS_PER_TOKEN = 4

function entryId(): EntryId {
	const bytes = new Uint8Array(4)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function messageChars(e: MessageEntry): number {
	if (e.role === 'tool_call') return JSON.stringify(e.input).length
	return e.content.length
}

function estimateTokens(entries: ReadonlyArray<SessionEntry>): number {
	let chars = 0
	for (const e of entries) {
		if (e.type === 'message') chars += messageChars(e)
		if (e.type === 'compaction') chars += e.summary.length
		if (e.type === 'branch_summary') chars += e.summary.length + (e.details?.length ?? 0)
	}
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

function walkBranch(entries: SessionEntry[], leafId: EntryId | null): SessionEntry[] {
	if (!leafId) return []
	const byId = new Map(entries.map(e => [e.id, e]))
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

const COMPACTION_PROMPT = `Summarize the following conversation into a concise recap that preserves all important context, decisions, and facts. The summary will replace the original messages in the model's context window, so include everything the model needs to continue the conversation coherently. Output only the summary, no preamble.`

export function session(path: string, volume: Volume, text: GenerateText): SessionManager {
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
		const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
		await sessionFile.append(lines)
	}

	const mgr: SessionManager = {
		sessionId: crypto.randomUUID(),
		get activeLeafId() { return activeLeafId },

		async append(payloads, compactionOptions) {
			await init()

			const now = new Date().toISOString()
			const newEntries: MessageEntry[] = []
			let parentId = activeLeafId

			for (const p of payloads) {
				const entry = { ...p, id: entryId(), parentId, ts: now } as MessageEntry
				newEntries.push(entry)
				parentId = entry.id
			}

			const allEntries = await sessionFile.jsonl(SessionEntrySchema)
			const branch = walkBranch([...allEntries, ...newEntries], parentId)

			const budget = compactionOptions?.contextBudget ?? DEFAULT_CONTEXT_BUDGET
			const systemTokens = compactionOptions?.systemPromptTokens ?? 0
			const available = budget - systemTokens
			const branchTokens = estimateTokens(branch)

			if (branchTokens > available) {
				const target = Math.floor(available * 0.5)
				let keptTokens = 0
				let splitIdx = branch.length
				for (let i = branch.length - 1; i >= 0; i--) {
					const e = branch[i]
					const t = e.type === 'message' ? Math.ceil(messageChars(e) / CHARS_PER_TOKEN) : 0
					if (keptTokens + t > target) { splitIdx = i + 1; break }
					keptTokens += t
				}
				splitIdx = Math.max(1, Math.min(splitIdx, branch.length - 1))

				const toFold = branch.slice(0, splitIdx)
				const foldText = toFold
					.filter((e): e is SessionEntry & { type: 'message'; role: 'user' | 'assistant'; content: string } =>
						e.type === 'message' && (e.role === 'user' || e.role === 'assistant'))
					.map(e => `${e.role}: ${e.content}`)
					.join('\n')

				const summary = await text(COMPACTION_PROMPT, foldText)
				const firstKept = branch[splitIdx]
				const compactionEntry: CompactionEntry = {
					type: 'compaction',
					id: entryId(),
					parentId: toFold[toFold.length - 1].id,
					ts: now,
					summary,
					firstKeptEntryId: firstKept.id,
					tokensBefore: estimateTokens(toFold),
				}

				const keptNew = newEntries.filter(e => {
					const idx = branch.indexOf(e)
					return idx >= splitIdx
				})
				if (keptNew.length > 0) {
					keptNew[0] = { ...keptNew[0], parentId: compactionEntry.id } as MessageEntry
				}

				await appendEntries([compactionEntry, ...keptNew])
				activeLeafId = keptNew.length > 0 ? keptNew[keptNew.length - 1].id : compactionEntry.id
				return { compacted: true }
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
					const keptIdx = branch.findIndex(e => e.id === c.firstKeptEntryId)
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
		branch() { throw new Error('not implemented') },
		branchWithSummary() { throw new Error('not implemented') },
		fork() { throw new Error('not implemented') },
	}

	return mgr
}
