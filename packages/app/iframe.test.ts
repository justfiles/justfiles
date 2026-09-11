import { MessageChannel } from 'node:worker_threads'
import { afterEach, expect, test, vi } from 'vitest'
import { guiFrameScript, guiHost, mountAppFrame } from './iframe.ts'

const nextMessage = (port: import('node:worker_threads').MessagePort) =>
	new Promise<unknown>((resolve) => port.once('message', resolve))

afterEach(() => vi.unstubAllGlobals())

test('a hosted GUI keeps its module URL', async () => {
	let boot: ((event: MessageEvent) => Promise<void>) | undefined
	const root = {} as { url?: string }
	const parentWindow = {}
	vi.stubGlobal('parent', parentWindow)
	vi.stubGlobal('document', { getElementById: () => root, title: '', head: {} })
	vi.stubGlobal(
		'MutationObserver',
		class {
			observe() {}
		}
	)
	vi.stubGlobal('window', {
		addEventListener: (_type: string, listener: (event: MessageEvent) => Promise<void>) => {
			if (_type === 'message') boot = listener
		}
	})
	await import(`data:text/javascript,${encodeURIComponent(guiFrameScript)}#hosted-gui-test`)

	const guiUrl = `data:text/javascript,${encodeURIComponent(
		'export const gui={mount(root){root.url=import.meta.url}}'
	)}`
	await boot?.({
		source: parentWindow,
		data: { type: 'boot', guiUrl, state: null },
		ports: [{ postMessage() {} }]
	} as unknown as MessageEvent)

	expect(root.url).toBe(guiUrl)
})

test('the GUI invokes the host and receives state through its port', async () => {
	const { port1, port2 } = new MessageChannel()
	const action = { type: 'increment', params: { amount: 1 } }
	const postState = guiHost(port1 as unknown as MessagePort, {
		invoke: async (message) => {
			expect(message).toEqual(action)
			return 'done'
		}
	})

	const invoked = nextMessage(port2)
	port2.postMessage({ type: 'invoke', id: 'request-1', action })
	expect(await invoked).toEqual({ type: 'invoked', id: 'request-1', result: 'done' })

	const state = nextMessage(port2)
	postState({ count: 1 })
	expect(await state).toEqual({ type: 'state', state: { count: 1 } })
	port1.close()
	port2.close()
})

test('state arriving during import reaches mount and titles stay bounded', async () => {
	let boot: ((event: MessageEvent) => Promise<void>) | undefined
	const gate = Promise.withResolvers<void>()
	const root: { state?: unknown; update?: unknown } = {}
	const parentWindow = {}
	vi.stubGlobal('parent', parentWindow)
	vi.stubGlobal('importGate', gate.promise)
	vi.stubGlobal('document', { getElementById: () => root, head: {}, title: '' })
	vi.stubGlobal(
		'MutationObserver',
		class {
			observe() {}
		}
	)
	vi.stubGlobal('window', {
		addEventListener(type: string, listener: typeof boot) {
			if (type === 'message') boot = listener
		}
	})
	await import(`data:text/javascript,${encodeURIComponent(guiFrameScript)}#pending-import`)
	const port = {
		postMessage: vi.fn(),
		onmessage: null as ((event: { data: unknown }) => void) | null
	}
	const guiUrl = `data:text/javascript,${encodeURIComponent(`
		await globalThis.importGate
		export const gui = { mount(root, state, {transport}) {
			root.state = state
			transport.subscribe(next => root.update = next)
			document.title = 'x'.repeat(300)
		} }
	`)}`
	const mounted = boot!({
		source: parentWindow,
		data: { type: 'boot', guiUrl, state: 0 },
		ports: [port]
	} as unknown as MessageEvent)
	port.onmessage!({ data: { type: 'state', state: 1 } })
	gate.resolve()
	await mounted
	expect(root).toEqual({ state: 1, update: 1 })
	expect(port.postMessage).toHaveBeenCalledWith({ type: 'title', title: 'x'.repeat(200) })
})

test('the GUI requests a validated dialog and receives its result', async () => {
	const { port1, port2 } = new MessageChannel()
	const request = {
		kind: 'choose' as const,
		title: 'File exists',
		actions: [
			{ id: 'cancel', label: 'Cancel', role: 'cancel' as const },
			{ id: 'keep-both', label: 'Keep Both' }
		]
	}
	guiHost(port1 as unknown as MessagePort, {
		invoke: async () => undefined,
		dialog: async (received) => {
			expect(received).toEqual(request)
			return 'keep-both'
		}
	})

	const response = nextMessage(port2)
	port2.postMessage({ type: 'dialog', id: 'dialog-1', request })
	expect(await response).toEqual({
		type: 'dialogResult',
		id: 'dialog-1',
		result: 'keep-both'
	})
	port1.close()
	port2.close()
})

test('the host rejects malformed dialog requests', async () => {
	const { port1, port2 } = new MessageChannel()
	const dialog = vi.fn()
	guiHost(port1 as unknown as MessagePort, { invoke: async () => undefined, dialog })

	const response = nextMessage(port2)
	port2.postMessage({
		type: 'dialog',
		id: 'dialog-2',
		request: { kind: 'choose', title: 'Too many', actions: [{}, {}, {}, {}] }
	})
	expect(await response).toEqual({
		type: 'dialogError',
		id: 'dialog-2',
		error: { message: 'Dialog request is not supported' }
	})
	expect(dialog).not.toHaveBeenCalled()
	port1.close()
	port2.close()
})

test('the host reports invoke errors and passes host messages to its caller', async () => {
	const { port1, port2 } = new MessageChannel()
	const errors: string[] = []
	const messages: Record<string, unknown>[] = []
	let errorDone!: () => void
	let messageDone!: () => void
	const received = Promise.all([
		new Promise<void>((resolve) => (errorDone = resolve)),
		new Promise<void>((resolve) => (messageDone = resolve))
	])
	guiHost(port1 as unknown as MessagePort, {
		invoke: async () => {
			throw new Error('failed')
		},
		onError: (message) => {
			errors.push(message)
			errorDone()
		},
		onMessage: (message) => {
			messages.push(message)
			messageDone()
		}
	})

	const failed = nextMessage(port2)
	port2.postMessage({ type: 'invoke', id: 'request-2', action: { type: 'fail' } })
	expect(await failed).toEqual({
		type: 'invokeError',
		id: 'request-2',
		error: { message: 'failed' }
	})

	port2.postMessage({ type: 'error', message: 'could not mount' })
	port2.postMessage({ type: 'shelf', hidden: true })
	await received
	expect(errors).toEqual(['could not mount'])
	expect(messages).toEqual([{ type: 'shelf', hidden: true }])
	port1.close()
	port2.close()
})

test('disposal stops queued requests, updates, and replies from pending actions', async () => {
	const { port1, port2 } = new MessageChannel()
	const pending = Promise.withResolvers<unknown>()
	const invoke = vi.fn(() => pending.promise)
	const post = vi.spyOn(port1, 'postMessage')
	const bridge = guiHost(port1 as unknown as MessagePort, { invoke })
	const queued = port1.onmessage!
	const event = { data: { type: 'invoke', id: '1', action: { type: 'increment' } } } as MessageEvent
	queued.call(port1, event)
	expect(invoke).toHaveBeenCalledOnce()
	bridge.dispose()
	queued.call(port1, event)
	bridge({ count: 1 })
	pending.resolve('done')
	await pending.promise
	await Promise.resolve()
	expect(invoke).toHaveBeenCalledOnce()
	expect(post).not.toHaveBeenCalled()
	port2.close()
})

test('mount, reload, and reattachment each boot once from current state', async () => {
	const channels: MessageChannel[] = []
	vi.stubGlobal(
		'MessageChannel',
		class {
			port1
			port2
			constructor() {
				const channel = new MessageChannel()
				channels.push(channel)
				this.port1 = channel.port1
				this.port2 = channel.port2
			}
		}
	)
	const postMessage = vi.fn()
	const frame = Object.assign(new EventTarget(), {
		style: {},
		title: '',
		srcdoc: '',
		isConnected: false,
		contentWindow: { postMessage },
		setAttribute: vi.fn(),
		remove() {
			this.isConnected = false
		}
	})
	vi.stubGlobal('document', { createElement: () => frame })
	const container = {
		append: () => {
			frame.isConnected = true
		}
	} as unknown as HTMLElement
	const invoke = vi.fn(async () => null)
	const mounted = mountAppFrame(container, 'export const gui = {}', { count: 0 }, { invoke })
	try {
		expect(frame.setAttribute).toHaveBeenCalledWith(
			'sandbox',
			'allow-scripts allow-forms allow-downloads'
		)
		expect(frame.srcdoc).toContain("connect-src 'none'")
		expect(frame.srcdoc).not.toContain('allow-same-origin')
		mounted.update({ count: 2 })
		frame.dispatchEvent(new Event('load'))
		expect(postMessage).toHaveBeenCalledOnce()
		expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ state: { count: 2 } })
		const old = channels[0]!.port1.onmessage!
		mounted.update({ count: 3 })
		frame.dispatchEvent(new Event('load'))
		old.call(channels[0]!.port1, {
			data: { type: 'invoke', id: 'late', action: { type: 'increment' } }
		} as MessageEvent)
		expect(invoke).not.toHaveBeenCalled()
		frame.remove()
		mounted.update({ count: 4 })
		container.append(frame as unknown as Node)
		frame.dispatchEvent(new Event('load'))
		expect(postMessage).toHaveBeenCalledTimes(3)
		expect(postMessage.mock.calls[2]?.[0]).toMatchObject({ state: { count: 4 } })
		mounted.dispose()
		frame.dispatchEvent(new Event('load'))
		expect(postMessage).toHaveBeenCalledTimes(3)
	} finally {
		mounted.dispose()
		for (const { port1, port2 } of channels) {
			port1.close()
			port2.close()
		}
	}
})
