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
	input: {},
	to: 'loaded',
	...over
})

function setup(
	opts: {
		invoke?: (req: { input: unknown }) => Promise<unknown>
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
			input: {},
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
