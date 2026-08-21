import { MessageChannel } from 'node:worker_threads'
import { expect, test } from 'vitest'
import { guiHost } from './iframe.ts'

const nextMessage = (port: import('node:worker_threads').MessagePort) =>
	new Promise<unknown>((resolve) => port.once('message', resolve))

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
