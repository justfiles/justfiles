import type { Command, Message, Result } from './app.ts'
import type { Capabilities } from './capabilities/types.ts'
import type { Declared } from './kernel.capability.ts'
import { CMD_RESULT_PREFIX } from './sdk.ts'

type AppId = string

interface CommandDeps {
	// Resolve a LOCAL capability name to its trusted { id, scopes } (the trust
	// boundary; see kernel.capability.ts). Undefined → the app never declared it.
	resolve: (appId: AppId, name: string) => Promise<Declared | undefined>
	// The capability seam's invoke arm. The runtime calls it with the RESOLVED
	// trusted id + scopes; nothing the isolate forwards. Absent → a command fails
	// with an err Result.
	invoke?: Capabilities['invoke']
	// Re-enter a message into the reducer (the kernel's dispatch). A command's
	// Result rides back in as a `__cmd/<to>` message — another reduce. Injecting
	// it keeps the runtime → kernel direction one-way (no import cycle).
	dispatch: (appId: AppId, message: Message) => Promise<unknown>
	// Surface a non-fatal failure (a result that could not be routed home).
	onError: (appId: AppId, error: string) => void
}

export interface Commands {
	// Run a command OFF the dispatch queue (a slow capability must not block the
	// GUI). Its typed Result re-enters the reducer as a `__cmd/<to>` message.
	schedule(appId: AppId, command: Command, actor?: string): void
	// The in-flight quiescence promise for an app — resolves when its outstanding
	// command count returns to zero — or undefined when none is running. `settled`
	// awaits it and reads undefined as "no command outstanding".
	pending(appId: AppId): Promise<void> | undefined
}

// The command executor (Part B): the only path that touches capabilities for the
// pure core. A transition emits a Command as data; the kernel runs it after
// persisting state and OUTSIDE the dispatch queue, then routes the typed Result
// back as a `__cmd/<to>` message.
export function commandRuntime({ resolve, invoke, dispatch, onError }: CommandDeps): Commands {
	// In-flight tracking. A command runs off-queue, but `settled` must still wait
	// for the whole cascade — emit → run → result re-enters → maybe emits again —
	// to quiesce. Each app counts its outstanding commands and holds a `done`
	// promise that resolves when the count returns to zero.
	const inflight = new Map<AppId, { count: number; done: Promise<void>; wake: () => void }>()
	// Single-flight state for coalescing commands (Part B). Per app, per structural
	// key {capability,method,args,to}: the presence of a slot means a run-loop for
	// that key is active; `trailing` records that an identical command arrived while
	// it ran, so the owner re-runs exactly once more when the current pass lands. In
	// memory only — like `inflight`, it describes work happening right now, so a
	// restart correctly starts from "nothing in flight".
	const coalescing = new Map<AppId, Map<string, { trailing: boolean }>>()

	return { schedule, pending }

	function pending(appId: AppId): Promise<void> | undefined {
		return inflight.get(appId)?.done
	}

	function started(appId: AppId): void {
		const entry = inflight.get(appId)
		if (entry) {
			entry.count++
			return
		}
		let wake!: () => void
		const done = new Promise<void>((res) => {
			wake = res
		})
		inflight.set(appId, { count: 1, done, wake })
	}

	function finished(appId: AppId): void {
		const entry = inflight.get(appId)
		if (!entry || --entry.count > 0) return
		inflight.delete(appId)
		entry.wake()
	}

	// Kick a command off without awaiting it — awaiting would deadlock the queue
	// (the result re-enters via `dispatch`, which chains on this app's tail). The
	// in-flight count, bumped synchronously, is what `pending`/`settled` waits on.
	function schedule(appId: AppId, command: Command, actor?: string): void {
		if (command.kind === 'none') return
		started(appId)
		void run(appId, command, actor).finally(() => finished(appId))
	}

	async function run(appId: AppId, command: Command, actor?: string): Promise<void> {
		if (command.kind === 'none') return
		if (command.kind === 'batch') {
			// No ordering or atomicity across a batch; each sub-command routes its
			// own ok/err result, so one failure never drops a sibling.
			await Promise.all(command.commands.map((c) => run(appId, c, actor)))
			return
		}
		if (command.coalesce) return runCoalesced(appId, command, actor)
		await runLeaf(appId, command, actor)
	}

	// Single-flight a coalescing command by its structural key. If a run-loop is
	// already active for the key, fold this call into a trailing re-run (do no work
	// here) — its result rides back on the owner's trailing pass, same `to` edge.
	// Otherwise become the owner: run, and while a trailing change latched during
	// the pass, run once more. The owner's `run` stays unresolved across the whole
	// chain, so its one in-flight count keeps `settled` pending until the tree
	// converges; a folded call resolves at once, releasing only its own count.
	async function runCoalesced(
		appId: AppId,
		command: Extract<Command, { kind: 'capability' }>,
		actor?: string
	): Promise<void> {
		const key = coalesceKey(command)
		let perApp = coalescing.get(appId)
		if (!perApp) {
			perApp = new Map()
			coalescing.set(appId, perApp)
		}
		const active = perApp.get(key)
		if (active) {
			active.trailing = true
			return
		}
		const slot = { trailing: false }
		perApp.set(key, slot)
		try {
			do {
				slot.trailing = false
				await runLeaf(appId, command, actor)
			} while (slot.trailing)
		} finally {
			perApp.delete(key)
			if (perApp.size === 0) coalescing.delete(appId)
		}
	}

	// Resolve trust, invoke the capability, and route the typed Result home. The
	// one place a leaf capability command touches the host executor — shared by the
	// direct and coalesced paths.
	async function runLeaf(
		appId: AppId,
		command: Extract<Command, { kind: 'capability' }>,
		actor?: string
	): Promise<void> {
		// The app named a LOCAL capability; resolve the trusted id + scopes from
		// its declarations — never from the command data.
		const declared = await resolve(appId, command.capability)
		const from = `capability:${declared?.id ?? command.capability}`
		if (!declared) {
			await deliver(
				appId,
				command.to,
				errResult(`undeclared capability: ${command.capability}`),
				from
			)
			return
		}
		if (!invoke) {
			await deliver(appId, command.to, errResult('capability execution unavailable'), from)
			return
		}
		try {
			const value = await invoke({
				appId,
				capability: declared.id,
				method: command.method,
				args: command.args,
				scopes: declared.scopes,
				actor
			})
			await deliver(appId, command.to, { ok: true, value }, from)
		} catch (error) {
			await deliver(appId, command.to, errResult(error), from)
		}
	}

	// Re-enter a command's Result as a `__cmd/<to>` message. A dangling result —
	// the `to` edge no longer exists (the app was reinstalled) or its reducer
	// threw — is surfaced via onError, not allowed to crash the executor.
	async function deliver(
		appId: AppId,
		to: string,
		params: Result<unknown>,
		actor: string
	): Promise<void> {
		try {
			await dispatch(appId, { type: `${CMD_RESULT_PREFIX}${to}`, params, actor })
		} catch (error) {
			onError(appId, errMessage(error))
		}
	}
}

function errMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// The structural single-flight key for a coalescing command. Mirrors the
// subscription reconciler's `subKey` ({capability,method,args,to}) so both
// runtimes identify "the same work" the same way. Scoped per app by the caller,
// so it never crosses the trust boundary.
function coalesceKey(command: Extract<Command, { kind: 'capability' }>): string {
	return JSON.stringify([command.capability, command.method, command.args, command.to])
}

// Shape a thrown value (or message) into the `Result` error a `fromResult` edge
// folds into state.
function errResult(error: unknown): Result<unknown> {
	return { ok: false, error: { message: errMessage(error) } }
}
