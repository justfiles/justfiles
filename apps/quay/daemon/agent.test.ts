import type { Kernel } from '@justfiles/app/runtime'
import { expect, test } from 'vitest'
import { abortAgent, classifyFailure, createAppController, type WindowOps } from './agent'

// The AppController is a thin bridge over the kernel + native window ops. The
// behaviour worth protecting lives here: preview apps are hidden, `current`
// tracks the launched app, `close` resolves a bundle name and clears state, and
// `run` stamps the agent as the actor. A fake kernel exercises all of it offline.

const COUNTER = 'app.justfiles.counter'

function fakeKernel() {
	const dispatched: { appId: string; message: unknown }[] = []
	const manifests = [
		{ id: COUNTER, name: 'Counter', description: 'count things' },
		{ id: 'preview.tmp', name: 'Preview', description: 'transient' }
	]
	const kernel = {
		list: async () => manifests,
		app: async (id: string) => ({ manifest: manifests.find((m) => m.id === id) }),
		state: async () => ({ count: 0 }),
		actions: async () => ({ increment: { kind: 'handler' } }),
		dispatch: async (appId: string, message: unknown) => {
			dispatched.push({ appId, message })
			return { count: 1 }
		}
	} as unknown as Kernel
	return { kernel, dispatched }
}

function spyWindows() {
	const opened: { id: string; name: string }[] = []
	const closed: string[] = []
	const windows: WindowOps = {
		open: (id, name) => opened.push({ id, name }),
		close: (name) => closed.push(name)
	}
	return { windows, opened, closed }
}

test('list omits preview apps', async () => {
	const { kernel } = fakeKernel()
	const apps = await createAppController(kernel, spyWindows().windows).list()
	expect(apps.map((a) => a.id)).toEqual([COUNTER])
})

test('launch opens the bundle, becomes current, and returns the inspection', async () => {
	const { kernel } = fakeKernel()
	const { windows, opened } = spyWindows()
	const controller = createAppController(kernel, windows)

	expect(await controller.current()).toBeUndefined()

	const app = await controller.launch(COUNTER)
	expect(opened).toEqual([{ id: COUNTER, name: 'Counter' }])
	expect(app).toMatchObject({ id: COUNTER, name: 'Counter', state: { count: 0 } })
	expect(await controller.current()).toMatchObject({ id: COUNTER })
})

test('close with no id quits the current app by its bundle name and clears it', async () => {
	const { kernel } = fakeKernel()
	const { windows, closed } = spyWindows()
	const controller = createAppController(kernel, windows)

	await controller.launch(COUNTER)
	await controller.close()
	expect(closed).toEqual(['Counter'])
	expect(await controller.current()).toBeUndefined()
})

test('close with no current app is a no-op', async () => {
	const { kernel } = fakeKernel()
	const { windows, closed } = spyWindows()
	await createAppController(kernel, windows).close()
	expect(closed).toEqual([])
})

test('run dispatches into the kernel stamped as the agent', async () => {
	const { kernel, dispatched } = fakeKernel()
	await createAppController(kernel, spyWindows().windows).run(COUNTER, 'increment', { amount: 2 })
	expect(dispatched).toEqual([
		{ appId: COUNTER, message: { type: 'increment', params: { amount: 2 }, actor: 'agent' } }
	])
})

// Abort guards on the memoised shared session: with no session ever built (a cold daemon),
// it must be a no-op rather than building an agent (which needs a backend) just to cancel
// nothing. The "session exists" branch runs the real assistant, so it's exercised live.
test('abort with no built session is a no-op', () => {
	expect(() => abortAgent()).not.toThrow()
})

// Turn failures reach the user classified, not raw: an expired/unauthorised token routes to
// Settings → Accounts, a blown context window / rate limit sends them back to chat, and
// everything else is a generic error that opens chat. This is what the chat error block and
// the notification banner both key off.
test('classifyFailure routes auth errors to Accounts', () => {
	for (const raw of ['401 Unauthorized', 'token expired', 'invalid_api_key']) {
		const failure = classifyFailure(new Error(raw))
		expect(failure.route).toEqual({ kind: 'settings', pane: 'accounts' })
		expect(failure.body).toMatch(/Accounts/)
	}
})

test('classifyFailure routes token-limit errors to a fresh chat', () => {
	for (const raw of ['context length exceeded', '429 rate limit']) {
		const failure = classifyFailure(new Error(raw))
		expect(failure.route).toEqual({ kind: 'chat' })
		expect(failure.body).toMatch(/new chat/)
	}
})

test('classifyFailure falls back to a generic chat error', () => {
	const failure = classifyFailure(new Error('kernel exploded'))
	expect(failure.route).toEqual({ kind: 'chat' })
	expect(failure.body).toBe('Agent error: kernel exploded')
})
