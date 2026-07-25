import { expect, test } from 'vitest'
import { type AppControllerPorts, createAppController } from './app-controller.ts'
import type { Kernel } from './kernel.ts'

// The AppController is a thin bridge over the kernel + a platform window seam. The
// behaviour worth protecting: preview apps are hidden, `run` stamps the agent as the
// actor, `close` resolves a bundle name, and "current" is either tracked in memory
// (last launched) or resolved by a host-supplied `focus`. A fake kernel exercises it
// all offline.

const COUNTER = 'com.example.counter'

function fakeKernel() {
	const dispatched: { appId: string; message: unknown }[] = []
	const calls: string[] = []
	const manifests = [
		{ id: COUNTER, name: 'Counter', description: 'count things' },
		{ id: 'preview.tmp', name: 'Preview', description: 'transient' }
	]
	const kernel = {
		list: async () => manifests,
		app: async (id: string) => ({ manifest: manifests.find((m) => m.id === id) }),
		state: async () => ({ count: 0 }),
		actions: async () => ({ increment: { kind: 'handler' } }),
		reload: async (id: string) => {
			calls.push(`reload:${id}`)
		},
		dispatch: async (appId: string, message: unknown) => {
			calls.push(`dispatch:${appId}`)
			dispatched.push({ appId, message })
			return { count: 1 }
		}
	} as unknown as Kernel
	return { kernel, dispatched, calls }
}

function spyWindows() {
	const opened: { id: string; name: string }[] = []
	const closed: { id: string; name: string }[] = []
	const windows: AppControllerPorts['windows'] = {
		open: (id, name) => opened.push({ id, name }),
		close: (id, name) => closed.push({ id, name })
	}
	return { windows, opened, closed }
}

test('list omits preview apps', async () => {
	const { kernel } = fakeKernel()
	const apps = await createAppController(kernel, { windows: spyWindows().windows }).list()
	expect(apps.map((a) => a.id)).toEqual([COUNTER])
})

test('launch opens the bundle, becomes current, and returns the inspection', async () => {
	const { kernel } = fakeKernel()
	const { windows, opened } = spyWindows()
	const controller = createAppController(kernel, { windows })

	expect(await controller.current()).toBeUndefined()

	const app = await controller.launch(COUNTER)
	expect(opened).toEqual([{ id: COUNTER, name: 'Counter' }])
	expect(app).toMatchObject({ id: COUNTER, name: 'Counter', state: { count: 0 } })
	expect(await controller.current()).toMatchObject({ id: COUNTER })
})

test('close with no id quits the current app by its bundle name and clears it', async () => {
	const { kernel } = fakeKernel()
	const { windows, closed } = spyWindows()
	const controller = createAppController(kernel, { windows })

	await controller.launch(COUNTER)
	await controller.close()
	expect(closed).toEqual([{ id: COUNTER, name: 'Counter' }])
	expect(await controller.current()).toBeUndefined()
})

test('close with no current app is a no-op', async () => {
	const { kernel } = fakeKernel()
	const { windows, closed } = spyWindows()
	await createAppController(kernel, { windows }).close()
	expect(closed).toEqual([])
})

test('run reloads before dispatching into the kernel as the agent', async () => {
	const { kernel, dispatched, calls } = fakeKernel()
	await createAppController(kernel, { windows: spyWindows().windows }).run(COUNTER, 'increment', {
		amount: 2
	})
	expect(calls).toEqual([`reload:${COUNTER}`, `dispatch:${COUNTER}`])
	expect(dispatched).toEqual([
		{ appId: COUNTER, message: { type: 'increment', params: { amount: 2 }, actor: 'agent' } }
	])
})

test('a host-supplied focus resolves "current" instead of last-launched', async () => {
	const { kernel } = fakeKernel()
	const controller = createAppController(kernel, {
		windows: spyWindows().windows,
		focus: async () => COUNTER
	})
	// Never launched, but focus reports the app → current + close use it.
	expect(await controller.current()).toMatchObject({ id: COUNTER })
})

test('accepts a lazy kernel accessor (resolved per call)', async () => {
	const { kernel, dispatched } = fakeKernel()
	let built = 0
	const controller = createAppController(
		async () => {
			built++
			return kernel
		},
		{ windows: spyWindows().windows }
	)
	await controller.run(COUNTER, 'increment', {})
	expect(built).toBe(1)
	expect(dispatched).toHaveLength(1)
})
