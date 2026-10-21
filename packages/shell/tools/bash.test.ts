import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bashTool, tail } from './bash.ts'

describe('tail', () => {
	it('keeps short output whole', () => {
		expect(tail('a\nb\n')).toEqual({ text: 'a\nb\n', truncated: false })
	})

	it('keeps the last 2000 lines', () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `${i}`)
		const { text, truncated } = tail(`${lines.join('\n')}\n`)
		expect(truncated).toBe(true)
		expect(text.split('\n').slice(0, -1)).toEqual(lines.slice(500))
	})

	it('keeps the last 50KB, from the first whole line in them', () => {
		const line = `${'x'.repeat(99)}\n`
		const { text, truncated } = tail(`start\n${line.repeat(1000)}`)
		expect(truncated).toBe(true)
		expect(text).toBe(line.repeat(512))
	})

	it('cuts one long line on a character', () => {
		const { text } = tail('é'.repeat(30_000))
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024)
		expect(text).toBe('é'.repeat(text.length))
	})
})

describe.skipIf(process.platform !== 'darwin')('bashTool', () => {
	let base: string
	let root: string
	let denied: string
	const run = (command: string, cwd = '/') =>
		bashTool({ root, denied }).execute({ command }, { signal: new AbortController().signal, cwd })

	beforeAll(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), 'ghost-bash-')))
		root = join(base, 'files')
		denied = join(root, 'private')
		await mkdir(join(root, 'notes'), { recursive: true })
		await mkdir(denied)
		await writeFile(join(denied, 'credentials.json'), 'secret')
		await symlink(denied, join(base, 'link'))
		await symlink(join(denied, 'credentials.json'), join(root, 'notes', 'file-link'))
	})

	afterAll(async () => {
		await rm(base, { recursive: true, force: true })
	})

	it('runs in the ask’s directory mapped under the root', async () => {
		expect(await run('pwd', '/notes')).toEqual({ text: join(root, 'notes'), isError: false })
		expect(await run('pwd')).toEqual({ text: root, isError: false })
	})

	it('sets GHOST_VOLUME to the root', async () => {
		expect(await run('cd notes; echo "$GHOST_VOLUME"', '/')).toEqual({ text: root, isError: false })
	})

	it('reports a failing command with its exit code and output', async () => {
		expect(await run('echo out; echo err >&2; exit 3')).toEqual({
			text: 'out\nerr\n[exit code 3]',
			isError: true
		})
	})

	it('cuts long output to its end', async () => {
		const { text } = await run('seq 1 3000')
		expect(text.split('\n')[0]).toBe('[earlier output dropped]')
		expect(text.split('\n')[1]).toBe('1001')
		expect(text.endsWith('\n3000')).toBe(true)
	})

	it('kills a command at its timeout', async () => {
		const result = await bashTool({ root, denied }).execute(
			{ command: 'echo started; sleep 30', timeout: 0.5 },
			{ signal: new AbortController().signal, cwd: '/' }
		)
		expect(result).toEqual({ text: 'started\n[killed after 0.5 seconds]', isError: true })
	})

	it('cannot read or write the denied directory', async () => {
		for (const command of [
			`cat ${denied}/credentials.json`,
			`ls ${denied}`,
			`echo x > ${denied}/new`,
			`cat ${base}/link/credentials.json`,
			'cat notes/file-link'
		]) {
			const { text, isError } = await run(command)
			expect(isError, command).toBe(true)
			expect(text, command).toContain('Operation not permitted')
			expect(text, command).not.toContain('secret')
		}
	})

	it('finds nothing from the denied directory when it searches everything', async () => {
		const { text } = await run(`grep -r secret ${base} 2>/dev/null; true`)
		expect(text).toBe('(no output)')
	})
})
