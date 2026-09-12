import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'
import { run } from './dev-process.ts'

const use = { spawn, env: process.env }

test('one-shot subprocess collects output and reports startup and exit failures', async () => {
	expect(
		await run(
			use,
			process.execPath,
			['-e', 'process.stdin.on("data", x => process.stdout.write(x))'],
			'hello'
		)
	).toBe('hello')
	await expect(
		run(use, process.execPath, ['-e', 'console.error("login failed"); process.exit(1)'], '')
	).rejects.toThrow('login failed')
	await expect(run(use, '/nonexistent/justfiles-cli', [], '')).rejects.toThrow('ENOENT')
})

test('abort terminates a process that ignores SIGTERM and reaps its descendants', async () => {
	const stop = new AbortController()
	let pid: number | undefined
	let descendant: number | undefined
	const started = Promise.withResolvers<void>()
	const tracking = {
		...use,
		spawn: ((...args: Parameters<typeof spawn>) => {
			const child = spawn(...args)
			pid = child.pid
			child.stdout!.on('data', (chunk) => {
				descendant = Number(chunk.toString().trim())
				started.resolve()
			})
			return child
		}) as typeof spawn
	}
	const work = run(
		tracking,
		process.execPath,
		[
			'-e',
			`
		process.on('SIGTERM', () => {});
		const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
		console.log(child.pid); setInterval(() => {}, 1000);
	`
		],
		'',
		{ signal: stop.signal }
	)
	await started.promise
	stop.abort(new Error('cancelled'))
	await expect(work).rejects.toThrow('cancelled')
	for (const id of [pid, descendant])
		await expect
			.poll(() => {
				try {
					process.kill(id!, 0)
					return true
				} catch {
					return false
				}
			})
			.toBe(false)
})

test('captured output and diagnostics are bounded', async () => {
	await expect(
		run(
			use,
			process.execPath,
			['-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000)'],
			''
		)
	).rejects.toThrow('output exceeds')
	await expect(
		run(use, process.execPath, ['-e', 'console.error("x".repeat(5000)); process.exit(1)'], '')
	).rejects.toSatisfy((error: Error) => error.message.length <= 2000)
})
