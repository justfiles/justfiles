import { BACKGROUND_CONTEXT, type Context, withCancel } from '@earendil-works/chord/context'
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
import { armConsolidation, consolidationTask } from './consolidation.ts'
import { volumeEnv } from './env.ts'
import { classifyFailure } from './failure.ts'
import { createMirror, writeShellRecord } from './mirror.ts'
import { createNotes } from './notes.ts'
import {
	currentGeneration,
	dropOtherGenerations,
	liveBytes,
	prefixOf,
	useGeneration
} from './rotation.ts'
import { ghostSections } from './sections.ts'
import { DEFAULT_TIMEZONE } from './timezone.ts'
import { ASK, createTranscript, text } from './transcript.ts'
import { transcriptTool } from './transcript-tool.ts'
import type {
	Ghost,
	GhostDeps,
	GhostSettings,
	StateDatabase,
	Tool,
	TranscriptEvent
} from './types.ts'

const context = BACKGROUND_CONTEXT

/** The memo of a compaction's note, so a compaction rerun after a crash appends the same one. */
const NOTE_MEMO = 'ghost.note'
/** The entry kind that marks a reset's note as taken; the model never sees it. */
const NOTED = 'ghost.noted'

/**
 * State above this many bytes moves to a fresh generation at the next check: at open, and
 * after each night's consolidation. A measured ask with two tool rounds stores about 10 KB.
 */
const ROTATE_BYTES = 64 * 1024 * 1024

/** Open the ghost on `deps.state`, resuming whatever the last process left unfinished. */
export function openGhost(deps: GhostDeps): Promise<Ghost> {
	return openRotating(deps, ROTATE_BYTES)
}

/**
 * The ghost over generations of its state, rotating to a fresh one once the state holds more
 * than `maxBytes`. A rotation is a new session, its note taken, in a new generation; calls
 * made meanwhile wait for it, and watchers get the new generation's snapshot.
 */
export async function openRotating(deps: GhostDeps, maxBytes: number): Promise<Ghost> {
	const db = deps.state
	// The day the next consolidation starts at, carried into a new generation's task.
	let from: string | undefined
	let generation = 0
	let current!: Ghost
	let opened = false
	const listeners = new Set<(event: TranscriptEvent) => void>()
	let unwatch = () => {}
	// Calls running on the current generation, which a rotation waits for.
	const calls = new Set<Promise<unknown>>()
	let rotating: Promise<void> | undefined
	// Between closing the old generation and opening the new one.
	let switching = false
	// Why there is no generation to call: a rotation failed after closing the old one.
	let broken: unknown
	let closed = false
	const openGeneration = () =>
		openOn(deps, {
			state: unclosable(db),
			prefix: prefixOf(generation),
			from,
			afterNight(next) {
				from = next
				check()
			}
		})
	try {
		generation = await currentGeneration(db)
		// What a rotation the process died in left of the old generation.
		await dropOtherGenerations(db, generation)
		current = await openGeneration()
	} catch (error) {
		await db.close()
		throw error
	}
	const forward = (event: TranscriptEvent) => {
		for (const listener of listeners) {
			try {
				listener(event)
			} catch {
				listeners.delete(listener)
			}
		}
	}
	unwatch = current.watch(forward)
	opened = true
	check()

	/** Rotate when the state has grown past `maxBytes`; a failure before the switch leaves it for the next check. */
	function check(): void {
		// A night that ends while the first generation opens is checked once it is open.
		if (!opened || rotating !== undefined || closed) return
		rotating = rotate()
			.catch(() => {})
			.finally(() => {
				rotating = undefined
			})
	}

	async function rotate(): Promise<void> {
		if ((await liveBytes(db)) <= maxBytes) return
		await Promise.allSettled(calls)
		if (closed) return
		await current.newSession()
		if (closed) return
		switching = true
		unwatch()
		try {
			await current.close()
			generation += 1
			await useGeneration(db, generation)
			current = await openGeneration()
			unwatch = current.watch(forward)
		} catch (error) {
			broken = error
		} finally {
			switching = false
		}
	}

	async function call<T>(run: (ghost: Ghost) => Promise<T>): Promise<T> {
		while (rotating !== undefined) await rotating
		if (broken !== undefined) throw broken
		const running = run(current)
		calls.add(running)
		try {
			return await running
		} finally {
			calls.delete(running)
		}
	}

	return {
		ask: (text, opts) => call((ghost) => ghost.ask(text, opts)),
		// Not held back by a rotation, which waits for the very calls an abort ends.
		abort: () => current.abort(),
		newSession: (handoff) => call((ghost) => ghost.newSession(handoff)),
		watch(listener) {
			current.watch(listener)()
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async close() {
			closed = true
			// A rotation still waiting stops here; one switching generations closes the new one.
			if (switching) await rotating
			listeners.clear()
			unwatch()
			if (broken === undefined) await current.close()
			await db.close()
		}
	}
}

/** `db` for one generation's storage, which closes it when the database outlives it. */
function unclosable(db: StateDatabase): StateDatabase {
	return {
		exec: (sql) => db.exec(sql),
		run: (sql, ...params) => db.run(sql, ...params),
		get: (sql, ...params) => db.get(sql, ...params),
		all: (sql, ...params) => db.all(sql, ...params),
		transaction: (fn) => db.transaction(fn),
		close: async () => {}
	}
}

interface GenerationOptions {
	state: StateDatabase
	prefix: string | undefined
	/** The day a consolidation task this generation creates starts at. */
	from: string | undefined
	afterNight(from: string): void
}

/** The ghost on one generation of its state. */
async function openOn(deps: GhostDeps, opts: GenerationOptions): Promise<Ghost> {
	const env = volumeEnv(deps.volume)
	return open(deps, env, opts).catch(async (error) => {
		await env.close()
		throw error
	})
}

async function open(
	deps: GhostDeps,
	env: ReturnType<typeof volumeEnv>,
	opts: GenerationOptions
): Promise<Ghost> {
	const model = deps.settings?.model
	const timeZone = deps.settings?.timeZone ?? DEFAULT_TIMEZONE
	const notes = createNotes({
		volume: deps.volume,
		models: deps.models,
		model,
		shellId: deps.shell.id,
		timeZone
	})
	// Set once the transcript exists; the task cannot run before the harness resumes.
	let wake: (at: number) => void = () => {}
	const consolidation = consolidationTask({
		volume: deps.volume,
		models: deps.models,
		model,
		timeZone,
		onWake: (at) => wake(at),
		afterNight: opts.afterNight
	})
	const registry = createRegistry()
	const volumeTools = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()]
	const ownTools = [transcriptTool(deps.volume, timeZone)]
	const capabilities = [...volumeTools, ...ownTools, ...(deps.tools ?? [])].map((tool) => tool.name)
	registry.install(
		defineExtension({
			name: 'ghost',
			tools: [
				...volumeTools.map((tool) => inAskedCwd(tool, env.at)),
				...[...ownTools, ...(deps.tools ?? [])].map(toPiTool)
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
			],
			tasks: [consolidation]
		})
	)
	const harness = await Harness.open(
		await SqliteStorage.open(opts.state, opts.prefix === undefined ? {} : { prefix: opts.prefix }),
		{
			models: deps.models,
			registry,
			settings: { compaction: compactionPolicy(deps.settings?.compaction) }
		},
		context
	)
	const root = await harness.root(context)
	if (model !== undefined) await root.configure({ model }, context)

	// The mirror reads pi's entries, not the stream, so it also has those a reset or compaction
	// hides; the stream only says when to look.
	const mirror = createMirror({
		volume: deps.volume,
		shellId: deps.shell.id,
		timeZone,
		async *scan(after) {
			let cursor: Cursor | undefined
			do {
				const query = { minEntryId: after as EntryId | undefined, order: 'ascending' as const }
				const page = await root.entries(query, 50, cursor, context)
				for (const entry of page.items) if (after === undefined || entry.id > after) yield entry
				cursor = page.next
			} while (cursor !== undefined)
		}
	})
	// The shell record is written at open and at each turn's start and end, one write at a time.
	let recording = Promise.resolve()
	const record = () => {
		recording = recording
			.then(() => writeShellRecord(deps.volume, deps.shell, capabilities))
			.catch(() => {})
		return recording
	}
	await record()

	// One pi stream feeds every watcher; each starts from the transcript's current snapshot.
	const stream = await watchEvents(harness, root.id, context)
	const transcript = createTranscript(stream.snapshot)
	const listeners = new Set<(event: TranscriptEvent) => void>()
	let busy = transcript.current().status.busy
	const emit = (events: TranscriptEvent[]) => {
		for (const event of events)
			for (const listener of listeners) {
				// A throw from pi's listener would end the stream for every watcher; drop just this one.
				try {
					listener(event)
				} catch {
					listeners.delete(listener)
				}
			}
	}
	stream.start(async (events) => {
		const changes = transcript.apply(events)
		for (const event of changes) {
			if (event.type === 'entry' || event.type === 'snapshot') void mirror.sync()
			const status = event.type === 'status' || event.type === 'snapshot' ? event.status : undefined
			if (status !== undefined && status.busy !== busy) {
				busy = status.busy
				void record()
			}
		}
		emit(changes)
	})
	transcript.wake(
		await armConsolidation(
			harness,
			root,
			consolidation,
			{ on: deps.settings?.consolidate !== false, timeZone, from: opts.from },
			context
		)
	)
	wake = (at) => emit(transcript.wake(at))
	harness.resume()
	void mirror.sync()

	// Note work runs one at a time under the ghost's lifetime; `close` cancels and awaits it.
	// It starts with a reset whose note a process that died first left untaken.
	const alive = withCancel(context)
	let noting = noteNewestReset(alive.context).catch(() => {})

	/**
	 * Note the context the newest reset hid, unless a marker after it says that is done. Waits
	 * for idle first, since a reset waits for the running turn and is placed after it.
	 */
	async function noteNewestReset(context: Context): Promise<void> {
		await root.waitForIdle(context)
		let reset: EntryId | undefined
		let last: EntryId | undefined
		let cursor: Cursor | undefined
		do {
			const page = await root.entries({}, 50, cursor, context)
			for (const entry of page.items) {
				if (reset !== undefined) {
					last = entry.id
					break
				}
				if (entry.kind === NOTED) return
				if (entry.kind === 'pi.reset') reset = entry.id
			}
			cursor = last === undefined ? page.next : undefined
		} while (cursor !== undefined)
		if (reset === undefined) return
		if (last !== undefined) {
			const { messages } = await root.context(context, { at: last })
			await notes.append(await notes.take(messages, context.abortSignal))
		}
		await root.submit({ type: 'write', entry: { kind: NOTED, data: { reset } } }, context)
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
			await noting
			await root.reset(handoff, context)
			// Best effort, as before a compaction: the new session is already open, and a note
			// that failed is taken again at the next open.
			noting = noting.then(() => noteNewestReset(alive.context).catch(() => {}))
			await noting
		},
		watch(listener) {
			listener(transcript.current())
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async close() {
			alive.cancel()
			await noting
			listeners.clear()
			await stream.stop()
			// An idle ghost leaves its mirror whole. A running turn is cut off where it is instead
			// of waiting for the mirror, which catches up at the next open.
			if (!busy) await mirror.sync()
			await harness.close(context)
			await mirror.stop()
			await recording
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
