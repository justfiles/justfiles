import { expect, test } from 'bun:test'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fsStore } from '@justfiles/fs/fs'
import { type Cursor, type Node, ROOT } from '@justfiles/fs/store'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const privateFiles = [
	'accounts/account.json',
	'cache/apps/asset',
	'state/clientid',
	'state/installing',
	'active-ai.json'
]

async function rows(root: string): Promise<Node[]> {
	const store = fsStore(root, { mounts: ['private'] })
	const found: Node[] = []
	let cursor: Cursor | undefined
	try {
		for (;;) {
			const page = await store.since(cursor)
			found.push(...page.nodes)
			if (page.next === undefined || page.nodes.length === 0) return found
			cursor = page.next
		}
	} finally {
		await store.close?.()
	}
}

const childScript = `
	import { access } from 'node:fs/promises'
	import { join } from 'node:path'
	import { getVolume } from ${JSON.stringify(new URL('./fs.ts', import.meta.url).href)}
	import { startDaemon } from ${JSON.stringify(new URL('./main.ts', import.meta.url).href)}
	const daemon = await startDaemon({
		port: 0,
		projectApps: async () => {},
		identity: {
			getToken: async () => null,
			signIn: async () => { throw new Error('not used') },
			signOut: async () => {},
			currentUser: async () => null,
			ownerId: async () => null,
			onChange: () => () => {}
		}
	})
	if (!daemon) {
		console.log('__BLOCKED__')
		process.exit(0)
	}
	const support = process.env.FRIEREN_SUPPORT_DIR
	if (!support) throw new Error('missing support directory')
	const fs = await getVolume()
	await fs.writeFile('/note.txt', new TextEncoder().encode('main'))
	for (const path of ${JSON.stringify(privateFiles)}) {
		await fs.mkdir('/private/' + path.split('/').slice(0, -1).join('/'), { recursive: true })
		await fs.writeFile('/private/' + path, new TextEncoder().encode(path))
	}
	const watchEvent = join(support, 'watch-event')
	const note = () => void Bun.write(watchEvent, 'event')
	await fs.watch('/note.txt', note)
	await fs.watch('/private/state/clientid', note)
	await Bun.sleep(100)
	const eventFile = Bun.file(watchEvent)
	if (await eventFile.exists()) await eventFile.delete()
	const closeRace = process.env.FRIEREN_CLOSE_RACE === '1'
	let releaseWrite = () => {}
	let pendingWrite = Promise.resolve()
	if (closeRace) {
		const digest = crypto.subtle.digest.bind(crypto.subtle)
		const closingBytes = new TextEncoder().encode('during close')
		const gate = new Promise((resolve) => {
			releaseWrite = resolve
		})
		let blocked = false
		Object.defineProperty(crypto.subtle, 'digest', {
			configurable: true,
			value: async (algorithm, data) => {
				const bytes = new Uint8Array(data)
				if (
					!blocked &&
					bytes.length === closingBytes.length &&
					bytes.every((byte, index) => byte === closingBytes[index])
				) {
					blocked = true
					console.log('__WRITE_PENDING__')
					await gate
				}
				return digest(algorithm, data)
			}
		})
		// Stop before the first Store call so only the owner can see the pending work.
		pendingWrite = fs.writeFile('/closing.txt', closingBytes)
	}
	let closing = false
	process.on('SIGTERM', () => {
		if (closing) return
		closing = true
		void (async () => {
			const closed = daemon.close()
			if (closeRace) {
				console.log('__CLOSING__')
				const release = join(support, 'release-write')
				for (;;) {
					try {
						await access(release)
						break
					} catch {
						await Bun.sleep(10)
					}
				}
				releaseWrite()
				await pendingWrite
			}
			await closed
			await daemon.close()
			if (await eventFile.exists()) await eventFile.delete()
			console.log('__CLOSED__')
		})()
	})
	console.log('__ACQUIRED__')
	setInterval(() => {}, 1000)
	await new Promise(() => {})
	`

const daemonProcess = (support: string, closeRace = false) =>
	Bun.spawn([process.execPath, '--eval', childScript], {
		cwd: import.meta.dir,
		env: {
			...process.env,
			FRIEREN_SUPPORT_DIR: support,
			...(closeRace ? { FRIEREN_CLOSE_RACE: '1' } : {})
		},
		stdout: 'pipe',
		stderr: 'pipe'
	})

type DaemonProcess = ReturnType<typeof daemonProcess>

const signOutScript = `
	import { access, appendFile, readFile } from 'node:fs/promises'
	import { join } from 'node:path'
	import { identity } from ${JSON.stringify(new URL('./identity.ts', import.meta.url).href)}
	import { startDaemon } from ${JSON.stringify(new URL('./main.ts', import.meta.url).href)}
	const support = process.env.FRIEREN_SUPPORT_DIR
	if (!support) throw new Error('missing support directory')
	const log = join(support, 'sign-out.log')
	const record = (event) => appendFile(log, event + '\\n')
	let publish = () => {}
	Object.assign(identity, {
		getToken: async () => null,
		signIn: async () => { throw new Error('not used') },
		async signOut() {
			publish(null)
			await record('change')
			const release = join(support, 'release-sign-out')
			for (;;) {
				try {
					await access(release)
					break
				} catch {
					await Bun.sleep(10)
				}
			}
			await record('failed')
			throw new Error('the Keychain item remains')
		},
		currentUser: async () => ({ id: 'user-a' }),
		ownerId: async () => 'user-a',
		onChange(listener) {
			publish = listener
			return () => { publish = () => {} }
		}
	})
	const daemon = await startDaemon({
		port: 0,
		projectApps: async () => {},
		identity,
		terminate: () => {
			void record('terminated').then(() => process.exit(0))
		}
	})
	if (!daemon) throw new Error('daemon lock unavailable')
	const runtime = JSON.parse(await readFile(join(support, 'runtime.json'), 'utf8'))
	const socket = new WebSocket('ws://127.0.0.1:' + runtime.port + '/system')
	socket.onopen = () => socket.send(JSON.stringify({ type: 'command', id: 'out', name: 'sign-out' }))
	socket.onmessage = (event) => {
		const message = JSON.parse(String(event.data))
		if (message.type === 'commandResult' && message.id === 'out') void record('replied')
	}
	await new Promise(() => {})
	`

test.skipIf(process.platform !== 'darwin')(
	'keeps the daemon alive and reports a failed sign-out cleanup',
	async () => {
		const support = await mkdtemp(join(tmpdir(), 'kodama-sign-out-'))
		const child = Bun.spawn([process.execPath, '--eval', signOutScript], {
			cwd: import.meta.dir,
			env: {
				...process.env,
				FRIEREN_SUPPORT_DIR: support,
				KODAMA_STORE_ORIGIN: 'http://127.0.0.1:1'
			},
			stdout: 'ignore',
			stderr: 'pipe'
		})
		const log = join(support, 'sign-out.log')
		const events = async (): Promise<string[]> => {
			try {
				return (await readFile(log, 'utf8')).trim().split('\n')
			} catch {
				return []
			}
		}
		const waitFor = async (event: string): Promise<void> => {
			for (let left = 500; left > 0; left--) {
				if ((await events()).includes(event)) return
				await sleep(10)
			}
			throw new Error(`timed out waiting for ${event}`)
		}
		try {
			await waitFor('change')
			await sleep(100)
			expect(await events()).toEqual(['change'])

			await writeFile(join(support, 'release-sign-out'), '')
			await waitFor('replied')
			expect(await events()).toEqual(['change', 'failed', 'replied'])
			expect(
				await Promise.race([child.exited.then(() => 'exited'), sleep(200).then(() => 'alive')])
			).toBe('alive')
		} finally {
			child.kill('SIGKILL')
			await child.exited
			await rm(support, { recursive: true, force: true })
		}
	},
	20_000
)

async function marker(process: DaemonProcess, markers: string[]): Promise<string> {
	const reader = process.stdout.getReader()
	const decoder = new TextDecoder()
	let output = ''
	const read = async (): Promise<string> => {
		for (;;) {
			const chunk = await reader.read()
			if (chunk.done) throw new Error(`daemon exited without a marker: ${output}`)
			output += decoder.decode(chunk.value, { stream: true })
			const found = markers.find((value) => output.includes(value))
			if (found) return found
		}
	}
	try {
		return await Promise.race([
			read(),
			sleep(10_000).then(() => {
				throw new Error(`timed out waiting for daemon marker: ${output}`)
			})
		])
	} finally {
		reader.releaseLock()
	}
}

const offlineBootstrapScript = `
	import { startStorage } from ${JSON.stringify(new URL('./fs.ts', import.meta.url).href)}
	import { getKernel } from ${JSON.stringify(new URL('./kernel.ts', import.meta.url).href)}
	const storage = await startStorage({
		ownerId: 'user-a',
		getToken: async () => 'token',
		origin: 'http://hub.test',
		fetch: async () => { throw new Error('offline') }
	})
	const fs = storage.volume
	await getKernel()
	await fs.writeFile('/offline.txt', new TextEncoder().encode('local'))
	if (await fs.exists('/applications')) throw new Error('built-ins were written before sync')
	if (new TextDecoder().decode(await fs.readFile('/offline.txt')) !== 'local') {
		throw new Error('local read failed')
	}
	console.log('__UNSEEDED__')
	process.exit(0)
	`

test('keeps first-run kernel writes behind the first remote cycle', async () => {
	const support = await mkdtemp(join(tmpdir(), 'kodama-bootstrap-'))
	const child = Bun.spawn([process.execPath, '--eval', offlineBootstrapScript], {
		cwd: import.meta.dir,
		env: {
			...process.env,
			FRIEREN_SUPPORT_DIR: support
		},
		stdout: 'pipe',
		stderr: 'pipe'
	})
	try {
		expect(await marker(child, ['__UNSEEDED__'])).toBe('__UNSEEDED__')
		await child.exited
	} finally {
		child.kill('SIGKILL')
		await child.exited
		await rm(support, { recursive: true, force: true })
	}
}, 15_000)

test.skipIf(process.platform !== 'darwin')(
	'owns both stores, excludes a second daemon, and recovers after a crash',
	async () => {
		const support = await mkdtemp(join(tmpdir(), 'kodama-lock-'))
		const children: DaemonProcess[] = []
		try {
			const first = daemonProcess(support)
			const second = daemonProcess(support)
			children.push(first, second)
			const statuses = await Promise.all([
				marker(first, ['__ACQUIRED__', '__BLOCKED__']),
				marker(second, ['__ACQUIRED__', '__BLOCKED__'])
			])
			expect(statuses.toSorted()).toEqual(['__ACQUIRED__', '__BLOCKED__'])

			const winner = statuses[0] === '__ACQUIRED__' ? first : second
			winner.kill('SIGKILL')
			await winner.exited

			const mainRoot = join(support, 'volume-v2', 'main')
			const privateRoot = join(support, 'volume-v2', 'private')
			expect(await readFile(join(mainRoot, 'note.txt'), 'utf8')).toBe('main')
			await expect(access(join(privateRoot, 'note.txt'))).rejects.toThrow()
			for (const path of privateFiles)
				expect(await readFile(join(privateRoot, path), 'utf8')).toBe(path)
			await expect(access(join(mainRoot, 'private'))).rejects.toThrow()
			await expect(access(join(support, 'volume'))).rejects.toThrow()

			const feed = await rows(mainRoot)
			const mount = feed.find(
				(row) => !row.deleted && row.parent === ROOT && row.name === 'private'
			)
			expect(mount?.type).toBe('mount')
			expect(feed.some((row) => row.parent === mount?.id)).toBe(false)

			const replacement = daemonProcess(support, true)
			children.push(replacement)
			expect(await marker(replacement, ['__WRITE_PENDING__'])).toBe('__WRITE_PENDING__')
			const runtime = (await Bun.file(join(support, 'runtime.json')).json()) as { pid: number }
			expect(runtime.pid).toBe(replacement.pid)

			replacement.kill('SIGTERM')
			expect(await marker(replacement, ['__CLOSING__'])).toBe('__CLOSING__')
			const blocked = daemonProcess(support)
			children.push(blocked)
			expect(await marker(blocked, ['__ACQUIRED__', '__BLOCKED__'])).toBe('__BLOCKED__')
			await writeFile(join(support, 'release-write'), '')
			expect(await marker(replacement, ['__CLOSED__'])).toBe('__CLOSED__')
			expect(await Bun.file(join(support, 'runtime.json')).exists()).toBe(false)
			expect(await readFile(join(mainRoot, 'closing.txt'), 'utf8')).toBe('during close')
			await writeFile(join(mainRoot, 'note.txt'), 'changed after close')
			await writeFile(join(privateRoot, 'state', 'clientid'), 'changed after close')
			await sleep(150)
			expect(await Bun.file(join(support, 'watch-event')).exists()).toBe(false)
			expect(replacement.exitCode).toBeNull()

			const final = daemonProcess(support)
			children.push(final)
			expect(await marker(final, ['__ACQUIRED__'])).toBe('__ACQUIRED__')
		} finally {
			for (const child of children) {
				child.kill('SIGKILL')
				await child.exited
			}
			await rm(support, { recursive: true, force: true })
		}
	},
	30_000
)
