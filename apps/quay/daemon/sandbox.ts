import type { GetSandbox, Sandbox } from '@justfiles/app/runtime'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'

type Cell = {
	code: string
	sandbox: Sandbox
	stop: (error?: Error) => void
}

const cells = new Map<string, Cell>()

export const getSandbox: GetSandbox = async ({ appId, code }) => {
	let cell = cells.get(appId)
	if (cell?.code !== code) {
		cell?.stop(new Error('sandbox worker replaced'))
		cell = spawn(code, () => {
			if (cells.get(appId) === cell) cells.delete(appId)
		})
		cells.set(appId, cell)
	}
	return cell.sandbox
}

function spawn(code: string, onDead: () => void): Cell {
	const appUrl = blobUrl(code)
	const workerUrl = blobUrl(sandboxWorkerSource(appUrl, 'web'))
	const worker = new Worker(workerUrl, { smol: true, ref: false })
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.addEventListener('message', (event) => handler(event.data))
	})
	let stopped = false
	const stop = (error?: Error): void => {
		if (stopped) return
		stopped = true
		if (error) fail(error)
		worker.terminate()
		URL.revokeObjectURL(workerUrl)
		URL.revokeObjectURL(appUrl)
	}
	const die = (error: Error): void => {
		if (stopped) return
		onDead()
		stop(error)
	}
	worker.addEventListener('error', (event) => die(event.error ?? new Error(event.message)))
	worker.addEventListener('close', (event) =>
		die(new Error(`sandbox worker closed: ${event.code}`))
	)
	return { code, sandbox, stop }
}

function blobUrl(source: string): string {
	return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}
