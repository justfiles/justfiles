import type { AuthEvent } from '@earendil-works/pi-ai'
import type { Settled, TranscriptEvent } from '@justfiles/ghost'

// The socket protocol: JSON lines, one message per line, each way. A connection gets the
// ghost's watch stream from the start, snapshot first.

export type Request =
	| { type: 'ask'; id: string; text: string; cwd: string; steer?: boolean }
	| { type: 'abort' }
	| { type: 'new'; handoff?: string }
	| { type: 'status' }
	/** Sign in with ChatGPT; `device` takes the legacy device code flow instead. */
	| { type: 'login'; device?: boolean }

export type Reply =
	| TranscriptEvent
	/** The ask with this `id` is answered or failed. */
	| ({ type: 'settled' } & Settled)
	/** An `abort`, `new` or `login` is done. */
	| { type: 'done'; request: 'abort' | 'new' | 'login' }
	/** A step of a login in progress: the URL to open, a device code, progress. */
	| { type: 'auth'; event: AuthEvent }
	| { type: 'error'; message: string }

export function encode(message: Request | Reply): string {
	return `${JSON.stringify(message)}\n`
}

/**
 * Feed it text as it arrives; it calls `onMessage` once per complete line, or `onInvalid`
 * for a line that is not JSON.
 */
export function decoder(
	onMessage: (message: unknown) => void,
	onInvalid: (line: string) => void = () => {}
): (chunk: string) => void {
	let buffer = ''
	const parse = (line: string) => {
		let message: unknown
		try {
			message = JSON.parse(line)
		} catch {
			return onInvalid(line)
		}
		onMessage(message)
	}
	return (chunk) => {
		buffer += chunk
		let end = buffer.indexOf('\n')
		while (end >= 0) {
			const line = buffer.slice(0, end)
			buffer = buffer.slice(end + 1)
			if (line.trim() !== '') parse(line)
			end = buffer.indexOf('\n')
		}
	}
}

/** `message` as a request, or undefined when it is not one. */
export function asRequest(message: unknown): Request | undefined {
	if (typeof message !== 'object' || message === null) return undefined
	const m = message as Record<string, unknown>
	const optional = (key: string, type: string) => m[key] === undefined || typeof m[key] === type
	switch (m.type) {
		case 'ask':
			return typeof m.id === 'string' &&
				typeof m.text === 'string' &&
				typeof m.cwd === 'string' &&
				optional('steer', 'boolean')
				? (m as Request)
				: undefined
		case 'new':
			return optional('handoff', 'string') ? (m as Request) : undefined
		case 'login':
			return optional('device', 'boolean') ? (m as Request) : undefined
		case 'abort':
		case 'status':
			return m as Request
	}
	return undefined
}
