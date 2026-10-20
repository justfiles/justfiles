import type { Context } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import {
	type Conversation,
	type Cursor,
	defineTask,
	type Harness,
	type TaskRuntime
} from '@earendil-works/pi-durable'
import type { Volume } from '@justfiles/fs'
import * as paths from './paths.ts'
import { MEMORY_CONSOLIDATION_PROMPT } from './prompts.ts'
import { dailyNotes, readText } from './sections.ts'
import { dayBefore, dayInTz } from './timezone.ts'
import { text } from './transcript.ts'
import type { GhostStatus } from './types.ts'

/** The task's kind in the state database. */
const KIND = 'ghost.consolidation'
/** At most this many days of notes go into one consolidation; older ones stay on disk only. */
const MAX_DAYS = 7
const TEMP = `${paths.MEMORY}.tmp`

/**
 * `from` is the first day whose notes are not in core.md yet. A `write` holds the rewrite of
 * core.md and the hash it replaces.
 */
type Checkpoint =
	| { phase: 'wait'; from: string }
	| { phase: 'consolidate'; from: string }
	| { phase: 'write'; from: string; today: string; base: string; next: string }
type Input = { from: string }
/** Where the consolidation stands, as status shows it. */
export type ConsolidationState = NonNullable<GhostStatus['consolidation']>

interface ConsolidationDeps {
	volume: Volume
	models: Models
	model: { provider: string; modelId: string } | undefined
	timeZone: string
	/** Resolves the next time the conversation goes idle after an ask; rejects once `signal` aborts. */
	idle(signal: AbortSignal): Promise<void>
	/** Where the task stands, each time a phase starts. */
	onState(state: ConsolidationState): void
	/** A run is done and the task waits for the next. */
	afterRun(): void
}

/**
 * The daily consolidation: one background task that, each time the conversation goes idle
 * after an ask, looks for finished days since the last run and appends what the model finds
 * durable in every shell's daily notes of those days to core.md. No clock wakes it, since a
 * laptop sleeps through any hour: a day missed while asleep or closed waits for the next ask.
 * A run that fails or finds core.md changed under it keeps `from`, so the next one takes
 * those days again.
 */
export function consolidationTask(deps: ConsolidationDeps) {
	const { volume, timeZone } = deps
	const today = (runtime: TaskRuntime<Input, Checkpoint, null, object>) =>
		dayInTz(new Date(runtime.now()), timeZone)

	/** Wait for the next run, to start there at `from`. */
	async function rearm(
		runtime: TaskRuntime<Input, Checkpoint, null, object>,
		context: Context,
		from: string
	) {
		await runtime.commit(
			() => ({ status: 'running', checkpoint: { phase: 'wait', from } }),
			context
		)
		deps.afterRun()
	}

	return defineTask<Input, Checkpoint, null>({
		name: KIND,
		version: 1,
		initial: (input) => ({ phase: 'wait', ...input }),
		phases: {
			async wait(task, runtime, context) {
				const checkpoint = task.state.checkpoint
				deps.onState({ from: checkpoint.from, running: false })
				// Daily notes are written to the day they are taken on, so a day before today is whole.
				do await deps.idle(runtime.signal)
				while (checkpoint.from >= today(runtime))
				await runtime.commit(
					() => ({ status: 'running', checkpoint: { ...checkpoint, phase: 'consolidate' } }),
					context
				)
			},
			async consolidate(task, runtime, context) {
				const { from: start } = task.state.checkpoint
				deps.onState({ from: start, running: true })
				const end = today(runtime)
				const days = daysFrom(start, end).slice(-MAX_DAYS)
				let rewrite: { base: string; next: string } | undefined
				try {
					rewrite = await rewriteOf(deps, days, runtime.signal)
				} catch (error) {
					// Closing is not a failed run: the next process runs this phase again.
					if (runtime.signal.aborted) throw error
					runtime.report(error)
					return rearm(runtime, context, start)
				}
				if (rewrite === undefined) return rearm(runtime, context, end)
				const { base, next } = rewrite
				await runtime.commit(
					() => ({
						status: 'running',
						checkpoint: { phase: 'write', from: start, today: end, base, next }
					}),
					context
				)
			},
			// Its own phase, so a rerun after a crash writes the answer it already has instead of asking again.
			async write(task, runtime, context) {
				const { from, today, base, next } = task.state.checkpoint
				deps.onState({ from, running: true })
				let written = false
				try {
					written = await replaceIfUnchanged(volume, base, next)
				} catch (error) {
					if (runtime.signal.aborted) throw error
					runtime.report(error)
				}
				await rearm(runtime, context, written ? today : from)
			}
		},
		async abort(_task, runtime, context) {
			await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
		}
	})
}

/**
 * Keep one consolidation task alive on `conversation` when `on`, created to start at `from`,
 * or today, or abort it when not. Returns where it stands.
 */
export async function armConsolidation(
	harness: Harness,
	conversation: Conversation,
	task: ReturnType<typeof consolidationTask>,
	opts: { on: boolean; timeZone: string; from?: string },
	context: Context
): Promise<ConsolidationState | undefined> {
	const live = await liveTasks(conversation, context)
	if (!opts.on) {
		for (const record of live) await harness.abortTask(record.id, context)
		return undefined
	}
	const running = live[0]?.state
	if (running?.status === 'pending' || running?.status === 'running') {
		const { from, phase } = running.checkpoint as Checkpoint
		return { from, running: phase !== 'wait' }
	}
	const from = opts.from ?? dayInTz(new Date(), opts.timeZone)
	await conversation.commit(
		(tx) =>
			tx.createTask(
				task,
				{ from },
				{
					ownership: { kind: 'conversation' },
					background: true
				}
			),
		context
	)
	return { from, running: false }
}

/**
 * core.md with what the model finds durable in the notes of `days` appended, and the hash of
 * the core.md it extends; undefined when there is nothing to add.
 */
async function rewriteOf(
	deps: ConsolidationDeps,
	days: string[],
	signal: AbortSignal
): Promise<{ base: string; next: string } | undefined> {
	const notes = await dailyNotes(deps.volume, days)
	if (notes.length === 0) return undefined
	const core = (await readText(deps.volume, paths.MEMORY)) ?? ''
	const additions = await consolidate(deps, core, notes, signal)
	if (additions === '') return undefined
	const label = days.length === 1 ? days[0] : `${days[0]} to ${days.at(-1)}`
	const separator = core === '' ? '' : core.endsWith('\n') ? '\n' : '\n\n'
	return { base: await sha256(core), next: `${core}${separator}## ${label}\n\n${additions}\n` }
}

/** The day the live consolidation task on `conversation` starts its next night at, if any. */
export async function consolidationFrom(
	conversation: Conversation,
	context: Context
): Promise<string | undefined> {
	const live = await liveTasks(conversation, context)
	const state = live[0]?.state
	return state?.status === 'pending' || state?.status === 'running'
		? (state.checkpoint as Checkpoint).from
		: undefined
}

/** Every consolidation task on `conversation` not ended or being aborted, oldest first. */
function liveTasks(conversation: Conversation, context: Context) {
	return conversation.commit(async (tx) => {
		const live = []
		let cursor: Cursor | undefined
		do {
			const page = await tx.scanTasks({ conversationId: conversation.id, kind: KIND }, 50, cursor)
			live.push(
				...page.items.filter(
					(record) => record.state.status !== 'terminal' && !record.abortRequested
				)
			)
			cursor = page.next
		} while (cursor !== undefined)
		return live
	}, context)
}

/** The consolidation prompt over core.md and the notes: the bullets to append, '' when none. */
async function consolidate(
	{ models, model }: ConsolidationDeps,
	core: string,
	notes: { day: string; shell: string; text: string }[],
	signal: AbortSignal
): Promise<string> {
	const resolved = model && models.getModel(model.provider, model.modelId)
	if (!resolved) throw new Error('No model to consolidate memory with')
	const prompt = [
		'# Current durable memory (read-only)',
		'',
		core.trim() || '(empty)',
		...notes.flatMap(({ day, shell, text }) => [
			'',
			`# Daily notes, ${day}, shell ${shell}`,
			'',
			text
		])
	].join('\n')
	const answer = await models.complete(
		resolved,
		{
			systemPrompt: MEMORY_CONSOLIDATION_PROMPT,
			messages: [{ role: 'user', content: prompt, timestamp: Date.now() }]
		},
		{ signal }
	)
	if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
		throw new Error(answer.errorMessage ?? `Consolidation stopped: ${answer.stopReason}`)
	return text(answer.content).trim()
}

/**
 * Rewrite core.md to `next` through a temp file and a rename, while it still hashes to
 * `base`. True when core.md holds `next`, also from an earlier attempt; false when it
 * changed meanwhile, and then it is left alone.
 */
async function replaceIfUnchanged(volume: Volume, base: string, next: string): Promise<boolean> {
	const current = async () => sha256((await readText(volume, paths.MEMORY)) ?? '')
	const now = await current()
	if (now === (await sha256(next))) return true
	if (now !== base) return false
	await volume.mkdir(paths.MEMORY.slice(0, paths.MEMORY.lastIndexOf('/')), { recursive: true })
	await volume.writeFile(TEMP, new TextEncoder().encode(next))
	// Checked again after the slow part, the write, so a change made during it is kept too.
	if ((await current()) !== base) {
		await volume.rm(TEMP, { force: true })
		return false
	}
	await volume.rename(TEMP, paths.MEMORY)
	return true
}

/** The days from `first` up to, not including, `end`; all `YYYY-MM-DD`. */
function daysFrom(first: string, end: string): string[] {
	const days: string[] = []
	for (let day = end; day > first; ) {
		day = dayBefore(day)
		days.unshift(day)
	}
	return days
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
