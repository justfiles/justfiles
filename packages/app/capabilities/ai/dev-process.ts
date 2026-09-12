import type { SpawnOptionsWithoutStdio, spawn } from 'node:child_process'
import { MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } from './agent/text.ts'

export function run(
	use: { spawn: typeof spawn; env: NodeJS.ProcessEnv },
	command: string,
	args: string[],
	input: string,
	options: { signal?: AbortSignal; cwd?: string; decode?: (output: string) => string } = {}
): Promise<string> {
	options.signal?.throwIfAborted()
	if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error('AI input exceeds 1 MiB')
	return new Promise((resolve, reject) => {
		const spawnOptions: SpawnOptionsWithoutStdio = {
			env: use.env,
			stdio: 'pipe',
			cwd: options.cwd,
			detached: process.platform !== 'win32'
		}
		const child = use.spawn(command, args, spawnOptions)
		let stdout = ''
		let stderr = ''
		let bytes = 0
		let failed = false
		let failure: unknown
		let killTimer: ReturnType<typeof setTimeout> | undefined
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
				else child.kill(signal)
			} catch {
				/* The process may already have exited. */
			}
		}
		const stop = (reason: unknown) => {
			if (failed) return
			failed = true
			failure = reason
			kill('SIGTERM')
			killTimer = setTimeout(() => kill('SIGKILL'), 500)
		}
		const abort = () => stop(options.signal?.reason ?? new Error('AI request aborted'))
		options.signal?.addEventListener('abort', abort, { once: true })
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		const capture = (chunk: string, error: boolean) => {
			bytes += Buffer.byteLength(chunk)
			if (bytes > MAX_OUTPUT_BYTES * 2) return stop(new Error('AI output exceeds 2 MiB'))
			if (error) stderr = (stderr + chunk).slice(-2000)
			else stdout += chunk
		}
		child.stdout.on('data', (chunk: string) => capture(chunk, false))
		child.stderr.on('data', (chunk: string) => capture(chunk, true))
		child.on('error', stop)
		child.stdin.on('error', stop)
		child.on('close', (code) => {
			clearTimeout(killTimer)
			options.signal?.removeEventListener('abort', abort)
			// Descendants must not survive an otherwise successful one-shot invocation.
			if (child.pid) kill('SIGKILL')
			try {
				if (failed) throw failure
				let output: string
				try {
					output = options.decode ? options.decode(stdout) : stdout.trim()
				} catch (error) {
					if (code !== 0 && stderr.trim()) throw new Error(stderr.trim())
					throw error
				}
				if (code !== 0)
					throw new Error(
						(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`).slice(0, 2000)
					)
				resolve(output)
			} catch (error) {
				reject(error)
			}
		})
		if (options.signal?.aborted) abort()
		child.stdin.end(input)
	})
}
