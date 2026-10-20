import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { TSchema } from '@earendil-works/pi-ai'
import {
	type ConversationId,
	type Cursor,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type Tx,
	watchEvents
} from '@earendil-works/pi-durable'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { classifyFailure } from './failure.ts'
import { ASK, createTranscript, text } from './transcript.ts'
import type { Ghost, GhostDeps, Tool, TranscriptEvent } from './types.ts'

const context = BACKGROUND_CONTEXT

/** Open the ghost on `deps.state`, resuming whatever the last process left unfinished. */
export async function openGhost(deps: GhostDeps): Promise<Ghost> {
	const registry = createRegistry()
	registry.install(defineExtension({ name: 'ghost', tools: (deps.tools ?? []).map(toPiTool) }))
	const compaction = deps.settings?.compaction
	const harness = await Harness.open(
		await SqliteStorage.open(deps.state),
		{
			models: deps.models,
			registry,
			settings: compaction === undefined ? {} : { compaction: { enabled: compaction } }
		},
		context
	)
	const root = await harness.root(context)
	const model = deps.settings?.model
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

	return {
		async ask(input, { id, whenBusy = 'queue', cwd }) {
			const submission = await root.submit(
				{
					type: 'input',
					content: input,
					// The input carries its own cwd, so overlapping asks never see each other's.
					entry: { kind: ASK, data: cwd === undefined ? {} : { cwd } },
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
		newSession: (handoff) => root.reset(handoff, context),
		watch(listener) {
			listener(transcript.current())
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async close() {
			listeners.clear()
			await stream.stop()
			await harness.close(context)
		}
	}
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
