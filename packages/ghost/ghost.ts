import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { TSchema } from '@earendil-works/pi-ai'
import {
	CompactionTask,
	type ConversationId,
	type Cursor,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	Harness,
	hook,
	type ToolRegistration,
	type Tx,
	watchEvents
} from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool
} from '@earendil-works/pi-durable/tools'
import { volumeEnv } from './env.ts'
import { classifyFailure } from './failure.ts'
import { createNotes } from './notes.ts'
import { ghostSections } from './sections.ts'
import { DEFAULT_TIMEZONE } from './timezone.ts'
import { ASK, createTranscript, text } from './transcript.ts'
import type { Ghost, GhostDeps, GhostSettings, Tool, TranscriptEvent } from './types.ts'

const context = BACKGROUND_CONTEXT

/** The memo of a compaction's note, so a compaction rerun after a crash appends the same one. */
const NOTE_MEMO = 'ghost.note'

/** Open the ghost on `deps.state`, resuming whatever the last process left unfinished. */
export async function openGhost(deps: GhostDeps): Promise<Ghost> {
	const env = volumeEnv(deps.volume)
	return open(deps, env).catch(async (error) => {
		await env.close()
		throw error
	})
}

async function open(deps: GhostDeps, env: ReturnType<typeof volumeEnv>): Promise<Ghost> {
	const model = deps.settings?.model
	const timeZone = deps.settings?.timeZone ?? DEFAULT_TIMEZONE
	const notes = createNotes({
		volume: deps.volume,
		models: deps.models,
		model,
		shellId: deps.shell.id,
		timeZone
	})
	const registry = createRegistry()
	const volumeTools = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()]
	registry.install(
		defineExtension({
			name: 'ghost',
			tools: [
				...volumeTools.map((tool) => inAskedCwd(tool, env.at)),
				...(deps.tools ?? []).map(toPiTool)
			],
			sections: ghostSections({
				volume: deps.volume,
				shell: deps.shell,
				machineTools: (deps.tools ?? []).map((tool) => tool.name),
				timeZone
			}),
			hooks: [
				hook(CompactionTask, {
					// Notes on the entries about to be summarized, then pi's own summary goes ahead.
					async beforeCompact({ messages }, api, context) {
						try {
							const note =
								(await api.memo<string>(NOTE_MEMO, context)) ??
								(await api.memo(
									NOTE_MEMO,
									await notes.take(messages, context.abortSignal),
									context
								))
							await notes.append(note)
						} catch {
							// A lost note must not fail the compaction, and with it the turn waiting on it.
						}
						return undefined
					}
				})
			]
		})
	)
	const harness = await Harness.open(
		await SqliteStorage.open(deps.state),
		{
			models: deps.models,
			registry,
			settings: { compaction: compactionPolicy(deps.settings?.compaction) }
		},
		context
	)
	const root = await harness.root(context)
	if (model !== undefined) await root.configure({ model }, context)

	// One pi stream feeds every watcher; each starts from the transcript's current snapshot.
	const stream = await watchEvents(harness, root.id, context)
	const transcript = createTranscript(stream.snapshot)
	const listeners = new Set<(event: TranscriptEvent) => void>()
	stream.start(async (events) => {
		for (const event of transcript.apply(events))
			for (const listener of listeners) {
				// A throw from pi's listener would end the stream for every watcher; drop just this one.
				try {
					listener(event)
				} catch {
					listeners.delete(listener)
				}
			}
	})
	harness.resume()

	/** The entry just before the newest reset: the end of the context it hid. */
	async function beforeNewestReset(): Promise<EntryId | undefined> {
		let reset = false
		let cursor: Cursor | undefined
		do {
			const page = await root.entries({}, 50, cursor, context)
			for (const entry of page.items) {
				if (reset) return entry.id
				reset = entry.kind === 'pi.reset'
			}
			cursor = page.next
		} while (cursor !== undefined)
		return undefined
	}

	return {
		async ask(input, { id, whenBusy = 'queue', cwd }) {
			const submission = await root.submit(
				{
					type: 'input',
					content: input,
					// The input carries its own cwd, so overlapping asks never see each other's.
					entry: { kind: ASK, data: cwd === undefined ? { id } : { id, cwd } },
					requestId: id,
					whenBusy: whenBusy === 'steer' ? 'steer' : 'followUp'
				},
				context
			)
			const record = await submission.wait(context)
			if (record.status === 'unanswered')
				return { id, status: 'failed', failure: classifyFailure(record.reason, record.detail) }
			const answer = record.type === 'input' ? record.answer : undefined
			const entry =
				answer === undefined ? undefined : await root.commit((tx) => tx.entry(answer), context)
			const message = entry?.model?.[0]
			return {
				id,
				status: 'done',
				text: message?.role === 'assistant' ? text(message.content) : ''
			}
		},
		abort: () => root.abort(context),
		async newSession(handoff) {
			// A reset waits for the running turn. Once idle it is placed, and the note covers
			// exactly what it hid, including what that turn added after this call.
			await root.reset(handoff, context)
			await root.waitForIdle(context)
			try {
				const last = await beforeNewestReset()
				if (last === undefined) return
				const { messages } = await root.context(context, { at: last })
				await notes.append(await notes.take(messages))
			} catch {
				// Best effort, as before a compaction: the new session is already open.
			}
		},
		watch(listener) {
			listener(transcript.current())
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async close() {
			listeners.clear()
			await stream.stop()
			await harness.close(context)
			await env.close()
		}
	}
}

function compactionPolicy(setting: GhostSettings['compaction']) {
	if (setting === false) return { enabled: false }
	return typeof setting === 'object' ? setting : {}
}

/**
 * The cwd of the input being answered: the newest ask, since a follow-up is placed only once
 * the run before it ends and a steer only between tool rounds.
 */
async function askedCwd(tx: Tx, conversationId: ConversationId): Promise<string> {
	let cursor: Cursor | undefined
	do {
		const page = await tx.scanEntries({ conversationId }, 50, cursor)
		const ask = page.items.find((entry) => entry.kind === ASK)
		if (ask !== undefined) return (ask.data as { cwd?: string }).cwd ?? '/'
		cursor = page.next
	} while (cursor !== undefined)
	return '/'
}

/** A pi tool given the Volume as its environment, at the cwd of the ask it answers. */
function inAskedCwd<T extends ToolRegistration>(tool: T, env: (cwd: string) => ExecutionEnv): T {
	return {
		...tool,
		async execute(args, api, context) {
			const cwd = await api.commit((tx) => askedCwd(tx, api.conversationId), context)
			return tool.execute(args, { ...api, env: env(cwd) }, context)
		}
	}
}

/** A ghost `Tool` as a pi tool. Not replay-safe: a call cut off by a restart reports so. */
function toPiTool(tool: Tool) {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as TSchema,
		async execute(params, api, context) {
			const signal = context.abortSignal ?? new AbortController().signal
			const cwd = await api.commit((tx) => askedCwd(tx, api.conversationId), context)
			const result = await tool.execute(params, { signal, cwd })
			return { output: [{ type: 'text', text: result.text }], isError: result.isError ?? false }
		}
	})
}
