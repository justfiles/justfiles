import { spawn } from 'node:child_process'
import type { Tool } from '@justfiles/ghost'
import { devicePath } from '../paths.ts'

// Real bash on this device, in place of the ghost's just-bash. Nothing stands between it and
// the disk but a sandbox that keeps it out of the private mount, where the shell's
// credentials are: what it reads goes into the transcript, and the transcript is synced.

/** The output kept, from the end, as pi's own `bash` keeps it. */
const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

const DEFAULT_TIMEOUT = 120
/** The longest a timer waits, in seconds. */
const MAX_TIMEOUT = 2_147_483

/** Everything is allowed but the denied directory. The sandbox matches resolved paths. */
const PROFILE = `(version 1)
(allow default)
(deny file-read* file-write* (subpath (param "DENIED")))`

interface Params {
	command: string
	timeout?: number
}

/**
 * `bash` on the disk under `root`, the Volume's root, starting in the ask's directory there,
 * with `GHOST_VOLUME` set to `root`. `denied` is the resolved path of a directory it can
 * neither read nor write.
 */
export function bashTool({ root, denied }: { root: string; denied: string }): Tool<Params> {
	return {
		name: 'bash',
		description: `Run a command with real bash on this device: real processes, with the user's programs on PATH (git, node, pnpm, ws, herdr and the rest). \`$GHOST_VOLUME\` is the Volume's directory on this device: the Volume path \`/x\` is \`"$GHOST_VOLUME/x"\` here, and a bare \`/x\` is this device's own root. The command starts in the directory the user asked from. \`$GHOST_VOLUME/private\` cannot be read or written. Returns stdout and stderr together, cut to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB. Waits for the command to exit, and kills it after ${DEFAULT_TIMEOUT} seconds unless \`timeout\` gives another limit, so do not start background processes.`,
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'Bash command to run' },
				timeout: {
					type: 'number',
					description: `Seconds before it is killed; default ${DEFAULT_TIMEOUT}`
				}
			},
			required: ['command']
		},
		async execute({ command, timeout = DEFAULT_TIMEOUT }, { signal, cwd }) {
			if (!(timeout > 0 && timeout <= MAX_TIMEOUT))
				throw new Error(`timeout must be between 0 and ${MAX_TIMEOUT} seconds`)
			const run = await bash(command, root, devicePath(cwd, root), denied, timeout * 1000, signal)
			const { text, truncated } = tail(run.output)
			const failure = run.timedOut
				? `[killed after ${timeout} seconds]`
				: run.code === null
					? `[killed by ${run.signal}]`
					: run.code === 0
						? undefined
						: `[exit code ${run.code}]`
			const parts = [
				...(truncated || run.dropped ? ['[earlier output dropped]'] : []),
				text === '' ? '(no output)' : text.replace(/\n$/, ''),
				...(failure === undefined ? [] : [failure])
			]
			return { text: parts.join('\n'), isError: failure !== undefined }
		}
	}
}

interface Run {
	output: string
	/** Output was dropped while running, beyond what `tail` keeps anyway. */
	dropped: boolean
	code: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
}

/** Run `command` in its own process group, so a timeout or abort kills what it started too. */
function bash(
	command: string,
	root: string,
	cwd: string,
	denied: string,
	timeoutMs: number,
	signal: AbortSignal
): Promise<Run> {
	signal.throwIfAborted()
	return new Promise((resolve, reject) => {
		const child = spawn(
			'/usr/bin/sandbox-exec',
			['-D', `DENIED=${denied}`, '-p', PROFILE, 'bash', '-c', command],
			{
				cwd,
				env: { ...process.env, GHOST_VOLUME: root },
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe']
			}
		)
		let output = ''
		let dropped = false
		let timedOut = false
		const kill = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
			} catch {}
		}
		const onData = (chunk: string) => {
			output += chunk
			// Bounded while it runs; `tail` makes the exact cut at the end.
			if (output.length > 4 * MAX_BYTES) {
				output = output.slice(-2 * MAX_BYTES)
				dropped = true
			}
		}
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding('utf8')
			stream.on('data', onData)
		}
		const timer = setTimeout(() => {
			timedOut = true
			kill()
		}, timeoutMs)
		const onAbort = () => kill()
		signal.addEventListener('abort', onAbort, { once: true })
		const done = () => {
			clearTimeout(timer)
			signal.removeEventListener('abort', onAbort)
		}
		child.on('error', (error) => {
			done()
			reject(new Error(`cannot run bash in ${cwd}: ${error.message}`))
		})
		child.on('close', (code, killed) => {
			done()
			if (signal.aborted) reject(signal.reason)
			else resolve({ output, dropped, code, signal: killed, timedOut })
		})
	})
}

/**
 * The end of `output` within `MAX_LINES` lines and `MAX_BYTES` bytes, starting at a line
 * when one starts inside the kept bytes.
 */
export function tail(output: string): { text: string; truncated: boolean } {
	let text = output
	const lines = text.split('\n')
	const trailing = lines.at(-1) === '' ? 1 : 0
	if (lines.length - trailing > MAX_LINES) text = lines.slice(-(MAX_LINES + trailing)).join('\n')
	const bytes = Buffer.from(text)
	if (bytes.length > MAX_BYTES) {
		let start = bytes.length - MAX_BYTES
		const newline = bytes.indexOf(10, start - 1)
		if (newline !== -1 && newline + 1 < bytes.length) start = newline + 1
		// Never half a character.
		while ((bytes[start] & 0xc0) === 0x80) start++
		text = bytes.subarray(start).toString('utf8')
	}
	return { text, truncated: text.length < output.length }
}
