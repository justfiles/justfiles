import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { TSchema } from '@earendil-works/pi-ai'
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	watchEvents
} from '@earendil-works/pi-durable'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { classifyFailure } from './failure.ts'
import { createTranscript, text } from './transcript.ts'
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
		for (const event of transcript.apply(events)) for (const listener of listeners) listener(event)
	})
	harness.resume()

	return {
		async ask(input, { id, whenBusy = 'queue', cwd }) {
			if (cwd !== undefined) await root.configure({ cwd }, context)
			const submission = await root.submit(
				{
					type: 'input',
					content: input,
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

/** A ghost `Tool` as a pi tool. Not replay-safe: a call cut off by a restart reports so. */
function toPiTool(tool: Tool) {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as TSchema,
		async execute(params, api, context) {
			const agent = await api.agent(context)
			const signal = context.abortSignal ?? new AbortController().signal
			const result = await tool.execute(params, { signal, cwd: agent.cwd ?? '/' })
			return { output: [{ type: 'text', text: result.text }], isError: result.isError ?? false }
		}
	})
}
