// Live app runner. Hosts (Frieren Dynamic Worker DO, Bun dev harness) drive
// app lifecycle through this single class so that invoke semantics — pure
// dispatch, state-entry task startup, abort on state exit, stale-result
// discard, persisted bookkeeping — are identical everywhere.
//
// The pure runtime helpers in `runtime.ts` are still the source of truth for
// transition validation, projection, and tool descriptors; the runner only
// adds live concerns that those helpers cannot express.

import type { AnyApp } from './app.js'
import type { Action, Actor, Snapshot } from './engine.js'
import {
	availableActions,
	briefing,
	type DispatchErr,
	type DispatchOk,
	initial as initialSnapshot,
	done as isDone,
	view as projectView,
	dispatch as pureDispatch,
	tools as pureTools,
	type ToolDescriptor
} from './runtime.js'
import type {
	AnyTask,
	InvocationMeta,
	InvokeDef,
	RunnerState,
	TaskContext,
	TaskError
} from './tasks.js'
import { SYSTEM_ACTOR } from './tasks.js'

type AnyInvokeDef = InvokeDef<Record<string, AnyTask>, string, unknown>

type ActiveInvoke = {
	meta: InvocationMeta
	controller: AbortController
}

/**
 * Persistence boundary for the runner. Hosts plug in CF DO storage, an
 * in-memory map, etc. Both methods may throw — the caller's behavior on
 * failure is host-defined.
 */
export interface RunnerStorage {
	load(): Promise<RunnerState | undefined>
	save(state: RunnerState): Promise<void>
}

/** In-memory storage convenient for tests and ephemeral hosts. */
export function memoryStorage(): RunnerStorage {
	let saved: RunnerState | undefined
	return {
		async load() {
			return saved
		},
		async save(state) {
			saved = state
		}
	}
}

export interface RunnerOptions<Host = Record<string, never>> {
	app: AnyApp
	storage?: RunnerStorage
	/**
	 * Per-invocation host context factory. Returned object is merged into
	 * `TaskContext` so capability bridges, env, etc. reach task handlers
	 * without leaking into pure engine code.
	 */
	host?: () => Host
	/** Notified after each successful state change (including system results). */
	onChange?: (snapshot: Snapshot) => void
	/**
	 * Notified when a task completes or fails. Hosts may surface for logging;
	 * stale/aborted outcomes are not reported here.
	 */
	onTaskSettled?: (event: { invocation: InvocationMeta; ok: boolean; error?: TaskError }) => void
}

export type RunnerDispatchResult = DispatchOk<Snapshot, unknown> | DispatchErr

/**
 * Live app runner. Construct, then `await start()` before dispatching.
 */
export class Runner<Host = Record<string, never>> {
	#app: AnyApp
	#storage: RunnerStorage
	#host?: () => Host
	#onChange?: (snapshot: Snapshot) => void
	#onTaskSettled?: RunnerOptions['onTaskSettled']
	#snapshot: Snapshot
	#active = new Map<string, ActiveInvoke>()
	#queue: Promise<unknown> = Promise.resolve()
	#started = false
	#stopped = false

	constructor(opts: RunnerOptions<Host>) {
		this.#app = opts.app
		this.#storage = opts.storage ?? memoryStorage()
		this.#host = opts.host
		this.#onChange = opts.onChange
		this.#onTaskSettled = opts.onTaskSettled
		this.#snapshot = initialSnapshot(this.#app)
	}

	get snapshot(): Snapshot {
		return this.#snapshot
	}

	async start(): Promise<Snapshot> {
		if (this.#started) return this.#snapshot
		this.#started = true
		const loaded = await this.#storage.load()
		if (loaded?.snapshot) {
			this.#snapshot = loaded.snapshot
		} else {
			this.#snapshot = initialSnapshot(this.#app)
			await this.#persist()
		}
		this.#startInvokesForState()
		return this.#snapshot
	}

	stop(): void {
		this.#stopped = true
		this.#abortAll()
	}

	view(actor: Actor): unknown {
		return projectView(this.#app, this.#snapshot, actor)
	}

	tools(actor?: Actor): ToolDescriptor[] {
		return pureTools(this.#app, actor)
	}

	availableActions(actor: Actor): readonly Action[] | null {
		return availableActions(this.#app, this.#snapshot, actor)
	}

	briefing(): string | null {
		return briefing(this.#app)
	}

	done(): boolean {
		return isDone(this.#app, this.#snapshot)
	}

	allows(actor: Actor, action: Action): boolean {
		return !!pureDispatch(this.#app, this.#snapshot, action, actor).ok
	}

	dispatch(action: Action, actor: Actor): Promise<RunnerDispatchResult> {
		return this.#enqueue(() => this.#dispatchNow(action, actor))
	}

	async reset(): Promise<Snapshot> {
		return this.#enqueue(async () => {
			this.#abortAll()
			this.#snapshot = initialSnapshot(this.#app)
			await this.#persist()
			this.#onChange?.(this.#snapshot)
			this.#startInvokesForState()
			return this.#snapshot
		})
	}

	#enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(fn, fn)
		this.#queue = next.catch(() => undefined)
		return next
	}

	async #dispatchNow(action: Action, actor: Actor): Promise<RunnerDispatchResult> {
		if (this.#stopped) return { ok: false, error: 'runner stopped' }
		const result = pureDispatch(this.#app, this.#snapshot, action, actor)
		if (!result.ok) return result
		const prevState = this.#snapshot.state
		const nextState = result.next.state
		this.#snapshot = result.next
		if (prevState !== nextState) {
			this.#abortAll()
		}
		await this.#persist()
		this.#onChange?.(this.#snapshot)
		if (prevState !== nextState) {
			this.#startInvokesForState()
		} else {
			this.#restartReenters()
		}
		return result
	}

	#startInvokesForState(): void {
		for (const inv of this.#invokesFor(this.#snapshot.state)) {
			const id = inv.id ?? inv.src
			if (this.#active.has(id)) continue
			this.#startInvoke(inv, id)
		}
	}

	#restartReenters(): void {
		for (const inv of this.#invokesFor(this.#snapshot.state)) {
			if (!inv.reenter) continue
			const id = inv.id ?? inv.src
			const existing = this.#active.get(id)
			if (existing) {
				existing.controller.abort()
				this.#active.delete(id)
			}
			this.#startInvoke(inv, id)
		}
	}

	#invokesFor(state: string): AnyInvokeDef[] {
		const def = this.#app.engine.states[state]
		const cfg = def?.invoke
		if (!cfg) return []
		return Array.isArray(cfg) ? [...cfg] : [cfg]
	}

	#startInvoke(invokeDef: AnyInvokeDef, id: string): void {
		const tasks = this.#app.engine.tasks as Record<string, AnyTask> | undefined
		const task = tasks?.[invokeDef.src]
		if (!task) {
			// Misconfigured app: surface via onError so author sees the failure.
			const err: TaskError = {
				code: 'TASK_FAILED',
				message: `unknown task: ${invokeDef.src}`
			}
			this.#fireResultAction(invokeDef, false, undefined, err)
			return
		}
		const runId = newRunId()
		const controller = new AbortController()
		const meta: InvocationMeta = {
			id,
			src: invokeDef.src,
			state: this.#snapshot.state,
			runId,
			startedAt: Date.now()
		}
		this.#active.set(id, { meta, controller })
		this.#persist().catch(() => undefined)

		const input = invokeDef.input
			? invokeDef.input({ context: this.#snapshot.context, snapshot: this.#snapshot })
			: undefined
		const hostCtx = this.#host ? this.#host() : ({} as Host)
		const ctx = {
			...(hostCtx as object),
			input,
			snapshot: this.#snapshot,
			signal: controller.signal
		} as TaskContext

		Promise.resolve()
			.then(() => task.handler(ctx))
			.then(
				(output) => this.#onTaskSuccess(id, runId, invokeDef, output),
				(err) => this.#onTaskFailure(id, runId, invokeDef, err, controller.signal.aborted)
			)
	}

	#onTaskSuccess(id: string, runId: string, invokeDef: AnyInvokeDef, output: unknown): void {
		if (!this.#isCurrent(id, runId)) return
		this.#active.delete(id)
		this.#persist().catch(() => undefined)
		this.#onTaskSettled?.({ invocation: this.#metaFor(id, runId, invokeDef), ok: true })
		this.#fireResultAction(invokeDef, true, output, undefined)
	}

	#onTaskFailure(
		id: string,
		runId: string,
		invokeDef: AnyInvokeDef,
		err: unknown,
		aborted: boolean
	): void {
		if (!this.#isCurrent(id, runId)) return
		this.#active.delete(id)
		this.#persist().catch(() => undefined)
		if (aborted) return
		const error = normalizeError(err)
		this.#onTaskSettled?.({ invocation: this.#metaFor(id, runId, invokeDef), ok: false, error })
		this.#fireResultAction(invokeDef, false, undefined, error)
	}

	#metaFor(id: string, runId: string, invokeDef: AnyInvokeDef): InvocationMeta {
		return {
			id,
			src: invokeDef.src,
			state: this.#snapshot.state,
			runId,
			startedAt: Date.now()
		}
	}

	#isCurrent(id: string, runId: string): boolean {
		const cur = this.#active.get(id)
		return !!cur && cur.meta.runId === runId
	}

	#fireResultAction(
		invokeDef: AnyInvokeDef,
		ok: boolean,
		output: unknown,
		error: TaskError | undefined
	): void {
		let action: Action | null | undefined
		if (ok && invokeDef.onDone) {
			action = invokeDef.onDone({ output, context: this.#snapshot.context })
		} else if (!ok && invokeDef.onError && error) {
			action = invokeDef.onError({ error, context: this.#snapshot.context })
		}
		if (action) {
			this.dispatch(action, SYSTEM_ACTOR).catch(() => undefined)
		}
	}

	#abortAll(): void {
		for (const { controller } of this.#active.values()) controller.abort()
		this.#active.clear()
	}

	async #persist(): Promise<void> {
		const invocations: InvocationMeta[] = [...this.#active.values()].map((a) => a.meta)
		await this.#storage.save({ snapshot: this.#snapshot, invocations })
	}
}

function newRunId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID()
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizeError(err: unknown): TaskError {
	if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
		const e = err as { code: unknown; message: unknown }
		if (typeof e.code === 'string' && typeof e.message === 'string') {
			return { code: e.code as TaskError['code'], message: e.message }
		}
	}
	const message = err instanceof Error ? err.message : String(err)
	return { code: 'TASK_FAILED', message }
}
