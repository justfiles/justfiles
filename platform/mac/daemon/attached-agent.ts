import type { Volume } from '@justfiles/fs'
import {
	type AttachedAgentChange,
	type AttachedAgentState,
	changeAttachedAgentState,
	initialAttachedAgentState,
	readAttachedAgentState
} from '../attached-agent'

const STATE_PATH = '/private/shell/attached-agent.json'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createAttachedAgentStore(volume: Volume | Promise<Volume>) {
	let state: Promise<AttachedAgentState> | undefined
	let writes = Promise.resolve()

	const read = () => (state ??= load(volume))
	const change = (appId: string, update: AttachedAgentChange) => {
		const result = writes.then(async () => {
			const next = changeAttachedAgentState(await read(), appId, update)
			state = Promise.resolve(next)
			const fs = await volume
			await fs.mkdir('/private/shell', { recursive: true })
			await fs.writeFile(STATE_PATH, encoder.encode(JSON.stringify(next)))
			return next
		})
		writes = result.then(
			() => undefined,
			() => undefined
		)
		return result
	}

	return { read, change }
}

async function load(volume: Volume | Promise<Volume>): Promise<AttachedAgentState> {
	try {
		const fs = await volume
		if (!(await fs.exists(STATE_PATH))) return initialAttachedAgentState
		return readAttachedAgentState(JSON.parse(decoder.decode(await fs.readFile(STATE_PATH))))
	} catch {
		return initialAttachedAgentState
	}
}
