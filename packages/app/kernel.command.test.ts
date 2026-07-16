import { expect, test } from 'vitest'
import type { Command, Message } from './app.ts'
import type { Declared } from './kernel.capability.ts'
import { commandRuntime } from './kernel.command.ts'

// The command runtime in isolation — no kernel, no sandbox. Injected fakes for
// the trust boundary (`resolve`), the host executor, the reducer re-entry
// (`dispatch`), and `onError`. Covers the resolve → invoke → deliver cascade,
// the err-Result paths, batches, quiescence via `pending`, and dangling results.

const declared: Record<string, Declared> = { volume: { id: 'volume', scopes: ['system'] } }
const resolve = async (_app: string, name: string) => declared[name]

type CapCommand = Extract<Command, { kind: 'capability' }>
const cap = (over: Partial<CapCommand> = {}): Command => ({
	kind: 'capability',
	capability: 'volume',
	method: 'scan',
	args: [{}],
	to: 'loaded',
	...over
})

function setup(
	opts: {
		invoke?: (req: { args: readonly unknown[] }) => Promise<unknown>
		dispatch?: (appId: string, message: Message) => Promise<unknown>
	} = {}
) {
	const dispatched: Array<{ appId: string; message: Message }> = []
	const errors: Array<{ appId: string; error: string }> = []
	const commands = commandRuntime({
		resolve,
		invoke: opts.invoke as never,
		dispatch:
			opts.dispatch ??
			(async (appId, message) => {
				dispatched.push({ appId, message })
				return undefined
			}),
		onError: (appId, error) => errors.push({ appId, error })
	})
	return { commands, dispatched, errors }
}

test('runs a capability command and re-enters its ok Result', async () => {
	const { commands, dispatched } = setup({ invoke: async () => [1, 2, 3] })
	commands.schedule('app', cap())
	await commands.pending('app')
	// The result re-enters tagged with the capability as actor, not the caller.
	expect(dispatched).toEqual([
		{
			appId: 'app',
			message: {
				type: '__cmd/loaded',
				params: { ok: true, value: [1, 2, 3] },
				actor: 'capability:volume'
			}
		}
	])
})

test('the kernel resolves trusted scopes — not the command data', async () => {
	const calls: unknown[] = []
	const { commands } = setup({
		invoke: async (req) => {
			calls.push(req)
			return null
		}
	})
	commands.schedule('app', cap({ method: 'scan' }), 'agent')
	await commands.pending('app')
	expect(calls).toEqual([
		{
			appId: 'app',
			capability: 'volume',
			method: 'scan',
			args: [{}],
			scopes: ['system'],
			actor: 'agent'
		}
	])
})

test('an undeclared capability delivers an err Result', async () => {
	const { commands, dispatched } = setup({ invoke: async () => 'x' })
	commands.schedule('app', cap({ capability: 'missing', to: 'done' }))
	await commands.pending('app')
	expect(dispatched[0]?.message.params).toEqual({
		ok: false,
		error: { message: 'undeclared capability: missing' }
	})
})

test('a thrown capability delivers an err Result', async () => {
	const { commands, dispatched } = setup({
		invoke: async () => {
			throw new Error('denied')
		}
	})
	commands.schedule('app', cap())
	await commands.pending('app')
	expect(dispatched[0]?.message.params).toEqual({ ok: false, error: { message: 'denied' } })
})

test('no host executor delivers an err Result', async () => {
	const dispatched: Array<{ appId: string; message: Message }> = []
	const commands = commandRuntime({
		resolve,
		invoke: undefined,
		dispatch: async (appId, message) => {
			dispatched.push({ appId, message })
			return undefined
		},
		onError: () => {}
	})
	commands.schedule('app', cap())
	await commands.pending('app')
	expect(dispatched[0]?.message.params).toEqual({
		ok: false,
		error: { message: 'capability execution unavailable' }
	})
})

test('a batch runs every sub-command as one in-flight unit', async () => {
	const { commands, dispatched } = setup({ invoke: async () => 'ok' })
	commands.schedule('app', {
		kind: 'batch',
		commands: [cap({ to: 'a' }), cap({ to: 'b' })]
	})
	await commands.pending('app')
	expect(dispatched.map((d) => d.message.type).sort()).toEqual(['__cmd/a', '__cmd/b'])
})

test('a none command is a no-op with nothing in flight', () => {
	const { commands, dispatched } = setup()
	commands.schedule('app', { kind: 'none' })
	expect(commands.pending('app')).toBeUndefined()
	expect(dispatched).toEqual([])
})

test('a result that fails to route is surfaced via onError', async () => {
	const { commands, errors } = setup({
		invoke: async () => 'x',
		dispatch: async () => {
			throw new Error('gone')
		}
	})
	commands.schedule('app', cap())
	await commands.pending('app')
	expect(errors).toEqual([{ appId: 'app', error: 'gone' }])
})

// ----- coalescing (opt-in single-flight) -----

// A gate the test resolves by hand, so it can hold an invoke open and observe
// what a second identical schedule does while the first is still running.
function gate() {
	let release!: (value: unknown) => void
	const promise = new Promise((res) => {
		release = res
	})
	return { promise, release }
}

// Flush microtasks past the resolve → invoke await chain (a macrotask boundary).
const tick = () => new Promise((r) => setTimeout(r, 0))

test('coalesce: an identical command in flight is folded into one trailing re-run', async () => {
	const gates = [gate(), gate(), gate()]
	let started = 0
	const { commands, dispatched } = setup({
		invoke: async () => {
			const g = gates[started++]
			await g?.promise
			return started
		}
	})
	const c = cap({ coalesce: true })
	// First schedule starts the run. Two more arrive while it is in flight: they
	// must NOT start their own invokes — they fold into a single trailing pass.
	commands.schedule('app', c)
	commands.schedule('app', c)
	commands.schedule('app', c)
	await tick()
	expect(started).toBe(1) // only the owner's invoke has started

	gates[0]?.release(null) // owner pass lands -> one trailing pass runs
	await tick()
	expect(started).toBe(2) // exactly one trailing invoke, not three

	gates[1]?.release(null)
	await commands.pending('app')
	expect(started).toBe(2) // no further runs after the trailing pass
	// Two deliveries (owner + trailing), both to the same `to` edge.
	expect(dispatched.map((d) => d.message.type)).toEqual(['__cmd/loaded', '__cmd/loaded'])
})

test('coalesce: pending stays until the trailing pass completes', async () => {
	const g0 = gate()
	const g1 = gate()
	const gates = [g0, g1]
	let started = 0
	const { commands } = setup({
		invoke: async () => {
			await gates[started++]?.promise
			return null
		}
	})
	const c = cap({ coalesce: true })
	commands.schedule('app', c)
	commands.schedule('app', c) // folds -> trailing
	const settled = commands.pending('app')
	expect(settled).toBeDefined()
	let done = false
	void settled?.then(() => {
		done = true
	})

	await tick()
	g0.release(null) // owner pass done, but a trailing pass is still owed
	await tick()
	expect(done).toBe(false) // one in-flight unit spans owner + trailing

	g1.release(null)
	await settled
	expect(done).toBe(true)
})

test('coalesce: a fresh identical command after quiescence runs again', async () => {
	let started = 0
	const { commands } = setup({
		invoke: async () => {
			started++
			return null
		}
	})
	const c = cap({ coalesce: true })
	commands.schedule('app', c)
	await commands.pending('app')
	expect(started).toBe(1)
	// The key was released on quiescence, so a later identical command is a new run.
	commands.schedule('app', c)
	await commands.pending('app')
	expect(started).toBe(2)
})

test('coalesce: distinct keys run concurrently, not folded together', async () => {
	const started: string[] = []
	const { commands } = setup({
		invoke: async (req) => {
			started.push(String((req.args[0] as { p: string }).p))
			return null
		}
	})
	// Same capability/method, different args -> different key -> both run.
	commands.schedule('app', cap({ coalesce: true, args: [{ p: 'a' }] }))
	commands.schedule('app', cap({ coalesce: true, args: [{ p: 'b' }] }))
	await commands.pending('app')
	expect(started.sort()).toEqual(['a', 'b'])
})

test('coalesce: a non-coalesced command is never single-flighted', async () => {
	let started = 0
	const g0 = gate()
	const g1 = gate()
	const gates = [g0, g1]
	const { commands } = setup({
		invoke: async () => {
			await gates[started++]?.promise
			return null
		}
	})
	commands.schedule('app', cap()) // no coalesce flag
	commands.schedule('app', cap()) // both run concurrently
	await tick()
	expect(started).toBe(2)
	g0.release(null)
	g1.release(null)
	await commands.pending('app')
})
