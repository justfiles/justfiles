import type { Context } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import {
	type Conversation,
	defineTask,
	type Harness,
	type TaskRuntime
} from '@earendil-works/pi-durable'
import type { Volume } from '@justfiles/fs'
import * as paths from './paths.ts'
import { MEMORY_CONSOLIDATION_PROMPT } from './prompts.ts'
import { dailyNotes, readText } from './sections.ts'
import { dayBefore, dayInTz, nextLocalHour } from './timezone.ts'
import { text } from './transcript.ts'

/** The task's kind in the state database. */
const KIND = 'ghost.consolidation'
/** The local hour the ghost consolidates at, in the settings' time zone. */
const HOUR = 4
/** At most this many days of notes go into one consolidation; older ones stay on disk only. */
const MAX_DAYS = 7
/** The longest single timer of a sleep: a timer stalls while the machine sleeps, the clock does not. */
const STEP_MS = 60 * 60_000
const TEMP = `${paths.MEMORY}.tmp`

/**
 * `until` is the next wake. `from` is the first day whose notes are not in core.md yet;
 * without it, yesterday. A `write` holds the rewrite of core.md and the hash it replaces.
 */
type Checkpoint =
	| { phase: 'sleep'; until: number; from?: string }
	| { phase: 'consolidate'; until: number; from?: string }
	| { phase: 'write'; until: number; from: string; today: string; base: string; next: string }
type Input = { until: number; from?: string }

interface ConsolidationDeps {
	volume: Volume
	models: Models
	model: { provider: string; modelId: string } | undefined
	timeZone: string
	/** The next wake, each time a phase starts; it is in the past while a consolidation runs. */
	onWake(at: number): void
	/** A night's work is done and the next one armed. */
	afterNight(): void
}

/**
 * The nightly consolidation: one background task that sleeps until 04:00, appends what the
 * model finds durable in every shell's daily notes since the last run to core.md, and arms
 * the next night in the same task. A night that fails or finds core.md changed under it
 * keeps `from`, so the next night takes those days again.
 */
export function consolidationTask(deps: ConsolidationDeps) {
	const { volume, timeZone } = deps

	/** Sleep until the next 04:00, to start there at `from`. */
	async function rearm(
		runtime: TaskRuntime<Input, Checkpoint, null, object>,
		context: Context,
		from: string
	) {
		const until = nextLocalHour(runtime.now(), HOUR, timeZone)
		await runtime.commit(
			() => ({ status: 'running', checkpoint: { phase: 'sleep', until, from } }),
			context
		)
		deps.afterNight()
	}

	return defineTask<Input, Checkpoint, null>({
		name: KIND,
		version: 1,
		initial: (input) => ({ phase: 'sleep', ...input }),
		phases: {
			async sleep(task, runtime, context) {
				const checkpoint = task.state.checkpoint
				deps.onWake(checkpoint.until)
				while (runtime.now() < checkpoint.until)
					await runtime.sleep(Math.min(checkpoint.until, runtime.now() + STEP_MS), context)
				await runtime.commit(
					() => ({ status: 'running', checkpoint: { ...checkpoint, phase: 'consolidate' } }),
					context
				)
			},
			async consolidate(task, runtime, context) {
				const { until, from } = task.state.checkpoint
				deps.onWake(until)
				// The days before today, from `from` on: a wake missed while the machine was off
				// takes them all once it is back.
				const today = dayInTz(new Date(runtime.now()), timeZone)
				const start = from ?? dayBefore(today)
				const days = daysFrom(start, today).slice(-MAX_DAYS)
				let rewrite: { base: string; next: string } | undefined
				try {
					rewrite = await rewriteOf(deps, days, runtime.signal)
				} catch (error) {
					// Closing is not a failed night: the next process runs this phase again.
					if (runtime.signal.aborted) throw error
					runtime.report(error)
					return rearm(runtime, context, start)
				}
				if (rewrite === undefined) return rearm(runtime, context, today)
				const { base, next } = rewrite
				await runtime.commit(
					() => ({
						status: 'running',
						checkpoint: { phase: 'write', until, from: start, today, base, next }
					}),
					context
				)
			},
			// Its own phase, so a rerun after a crash writes the answer it already has instead of asking again.
			async write(task, runtime, context) {
				const { from, today, base, next } = task.state.checkpoint
				deps.onWake(task.state.checkpoint.until)
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
 * Keep one consolidation task alive on `conversation` when `on`, created at the next 04:00
 * starting at `from`, or abort it when not. Returns its next wake.
 */
export async function armConsolidation(
	harness: Harness,
	conversation: Conversation,
	task: ReturnType<typeof consolidationTask>,
	opts: { on: boolean; timeZone: string; from?: string },
	context: Context
): Promise<number | undefined> {
	const live = await liveTasks(conversation, context)
	if (!opts.on) {
		for (const record of live) await harness.abortTask(record.id, context)
		return undefined
	}
	const running = live[0]?.state
	if (running?.status === 'pending' || running?.status === 'running')
		return (running.checkpoint as Checkpoint).until
	const until = nextLocalHour(Date.now(), HOUR, opts.timeZone)
	await conversation.commit(
		(tx) =>
			tx.createTask(task, opts.from === undefined ? { until } : { until, from: opts.from }, {
				ownership: { kind: 'conversation' },
				background: true
			}),
		context
	)
	return until
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

function liveTasks(conversation: Conversation, context: Context) {
	return conversation.commit(async (tx) => {
		const page = await tx.scanTasks({ conversationId: conversation.id, kind: KIND }, 50)
		return page.items.filter((record) => record.state.status !== 'terminal')
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
