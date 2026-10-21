import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { AuthEvent, ThinkingLevel } from '@earendil-works/pi-ai'
import type { TranscriptEntry } from '@justfiles/ghost'
import { connectOrStart, exchange, Lost } from './client.ts'
import { main } from './main.ts'
import { shellDir, volumeCwd } from './paths.ts'
import { type Reply, THINKING_LEVELS } from './protocol.ts'
import { readSettings, volumeRoot } from './settings.ts'

const USAGE = `usage:
  ghost ask "<text>" [--steer] [--json]
  ghost quick "<text>" [--system <text>] [--model <id>] [--effort <level>] [--json]
  ghost watch [--json]
  ghost new [--handoff <text>]
  ghost abort
  ghost status
  ghost login [--device]
  ghost serve`

/** How often an ask is sent again after the daemon went away mid-answer. */
const RETRIES = 3

async function run(argv: string[]): Promise<number> {
	const [command, ...rest] = argv
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			json: { type: 'boolean' },
			steer: { type: 'boolean' },
			system: { type: 'string' },
			model: { type: 'string' },
			effort: { type: 'string' },
			handoff: { type: 'string' },
			device: { type: 'boolean' }
		}
	})
	const dir = shellDir()
	switch (command) {
		case 'ask': {
			const text = positionals.join(' ')
			if (text === '') break
			const request = {
				type: 'ask' as const,
				id: randomUUID(),
				text,
				cwd: cwd(dir),
				...(values.steer ? { steer: true } : {})
			}
			let failed = false
			// The same id every time: the ghost answers it once, however often it is sent.
			for (let attempt = 0; ; attempt++) {
				// Per connection: what streamed before a reconnect may be a fragment of the answer.
				const show = printer({ echo: false })
				let printed = false
				let ours = false
				try {
					await exchange(await connectOrStart(dir), request, (reply) => {
						if (reply.type === 'error' || (reply.type === 'settled' && reply.status === 'failed'))
							failed = true
						// JSON gets every message: a snapshot replaces the state, also mid-answer.
						if (values.json) json(reply)
						else if (reply.type === 'snapshot') return false
						else if (reply.type === 'error') console.error(`ghost: ${reply.message}`)
						else if (reply.type !== 'settled') {
							// Inputs queued ahead of this one stream here too; show from this one on.
							if (
								reply.type === 'entry' &&
								reply.entry.kind === 'user' &&
								reply.entry.askId === request.id
							)
								ours = true
							else if (ours) printed = show(reply) !== '' || printed
						} else if (reply.status === 'failed') {
							console.error(`ghost: ${reply.failure.kind}: ${reply.failure.message}`)
							if (reply.failure.kind === 'auth') console.error('ghost: sign in with `ghost login`')
						}
						// Nothing streamed on this connection, as after a reconnect: show the whole answer.
						else if (!printed) process.stdout.write(`${reply.text}\n`)
						return reply.type === 'settled' || reply.type === 'error'
					})
					return failed ? 1 : 0
				} catch (error) {
					if (!(error instanceof Lost) || attempt === RETRIES) throw error
					if (printed && !values.json) process.stdout.write('\n')
				}
			}
		}
		case 'quick': {
			const text = positionals.join(' ')
			const effort = values.effort as ThinkingLevel | undefined
			if (text === '') break
			if (effort !== undefined && !THINKING_LEVELS.includes(effort)) {
				console.error(`ghost: --effort is one of ${THINKING_LEVELS.join(', ')}`)
				return 2
			}
			const request = {
				type: 'quick' as const,
				text,
				...(values.system === undefined ? {} : { system: values.system }),
				...(values.model === undefined ? {} : { model: values.model }),
				...(effort === undefined ? {} : { effort })
			}
			let failed = false
			await exchange(await connectOrStart(dir), request, (reply) => {
				if (reply.type !== 'quick' && reply.type !== 'error') return false
				if (reply.type === 'error') failed = true
				if (values.json) json(reply)
				else if (reply.type === 'quick') process.stdout.write(`${reply.text}\n`)
				else console.error(`ghost: ${reply.message}`)
				return true
			})
			return failed ? 1 : 0
		}
		case 'watch': {
			const show = values.json ? json : printer({ echo: true })
			await exchange(await connectOrStart(dir), undefined, (reply) => {
				show(reply)
				return false
			})
			return 0
		}
		case 'new':
		case 'abort': {
			const request =
				command === 'abort'
					? { type: 'abort' as const }
					: {
							type: 'new' as const,
							...(values.handoff === undefined ? {} : { handoff: values.handoff })
						}
			let error: string | undefined
			await exchange(await connectOrStart(dir), request, (reply) => {
				if (reply.type === 'error') error = reply.message
				return reply.type === 'done' || reply.type === 'error'
			})
			if (error !== undefined) console.error(`ghost: ${error}`)
			return error === undefined ? 0 : 1
		}
		case 'login': {
			let error: string | undefined
			await exchange(
				await connectOrStart(dir),
				{ type: 'login', ...(values.device ? { device: true } : {}) },
				(reply) => {
					if (reply.type === 'auth') announce(reply.event)
					if (reply.type === 'error') error = reply.message
					return reply.type === 'error' || (reply.type === 'done' && reply.request === 'login')
				}
			)
			if (error !== undefined) console.error(`ghost: ${error}`)
			else console.log('Signed in.')
			return error === undefined ? 0 : 1
		}
		case 'status':
			await exchange(await connectOrStart(dir), { type: 'status' }, (reply) => {
				if (reply.type !== 'status') return false
				console.log(JSON.stringify(reply.status))
				return true
			})
			return 0
		case 'serve':
			await main()
			return 0
	}
	console.error(USAGE)
	return 2
}

/** This directory as a Volume path; `/` outside the Volume. */
function cwd(dir: string): string {
	let root = volumeRoot(readSettings(dir))
	try {
		root = realpathSync(root)
	} catch {}
	return volumeCwd(process.cwd(), root)
}

/** A login step for the person signing in; the sign-in page opens in their browser. */
function announce(event: AuthEvent): void {
	switch (event.type) {
		case 'auth_url':
			console.log(`Sign in at ${event.url}`)
			spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [event.url], {
				detached: true,
				stdio: 'ignore'
			})
				.on('error', () => {})
				.unref()
			return
		case 'device_code':
			console.log(`Open ${event.verificationUri} and enter ${event.userCode}`)
			return
		case 'info':
		case 'progress':
			console.log(event.message)
	}
}

function json(reply: Reply): void {
	process.stdout.write(`${JSON.stringify(reply)}\n`)
}

/**
 * The transcript as text for a person: answers on stdout as they stream, tool calls on
 * stderr. With `echo`, the user's inputs too. Returns what it wrote to stdout.
 */
function printer({ echo }: { echo: boolean }) {
	let streamed = false
	const out = (text: string) => {
		process.stdout.write(text)
		return text
	}
	const entry = (entry: TranscriptEntry): string => {
		switch (entry.kind) {
			case 'user':
				return echo ? out(`› ${entry.text}\n`) : ''
			case 'assistant': {
				const text = streamed ? '\n' : entry.text === '' ? '' : `${entry.text}\n`
				streamed = false
				if (entry.error !== undefined) console.error(`ghost: ${entry.error}`)
				return out(text)
			}
			case 'reset':
				return echo ? out('— new session\n') : ''
			case 'compaction':
				return echo ? out('— compacted\n') : ''
			case 'tool':
				return ''
		}
	}
	return (event: Reply): string => {
		switch (event.type) {
			case 'snapshot': {
				let written = event.transcript.entries.map(entry).join('')
				if (event.transcript.partial) {
					written += out(event.transcript.partial)
					streamed = true
				}
				return written
			}
			case 'entry':
				return entry(event.entry)
			case 'text':
				streamed = true
				return out(event.delta)
			case 'tool': {
				const args = JSON.stringify(event.args)
				console.error(`· ${event.name} ${args.length > 120 ? `${args.slice(0, 119)}…` : args}`)
				return ''
			}
		}
		return ''
	}
}

run(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code
	},
	(error: unknown) => {
		console.error(`ghost: ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 1
	}
)
