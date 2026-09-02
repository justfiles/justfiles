import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { volume } from '@justfiles/fs'
import { authority } from '@justfiles/fs/authority'
import { memStore } from '@justfiles/fs/mem'
import { receiver } from '@justfiles/fs/peer'
import { versions } from '@justfiles/fs/synced'
import { afterEach, expect, test } from 'vitest'
import { storeApi } from '../../../packages/core/src/store.api'
import { createNativeStorage } from './fs'

const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
const servers: Server[] = []
const enc = new TextEncoder()
const dec = new TextDecoder()

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue
		child.kill('SIGKILL')
		await new Promise((resolve) => child.once('exit', resolve))
	}
	for (const server of servers.splice(0)) {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function temp(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'kodama-recovery-'))
	roots.push(root)
	return root
}

function child(
	script: string,
	supportDir: string,
	env: Record<string, string> = {}
): ChildProcessWithoutNullStreams {
	const process = spawn(
		globalThis.process.execPath,
		['--import', 'tsx', '--input-type=module', '--eval', script],
		{
			cwd: import.meta.dirname,
			env: { ...globalThis.process.env, FRIEREN_SUPPORT_DIR: supportDir, ...env }
		}
	)
	children.push(process)
	return process
}

async function backend(fault: { method: string; path: RegExp; body?: string }) {
	const store = authority(memStore())
	const fs = volume(store, { mintVersion: versions('backend') })
	const app = storeApi(receiver(store))
	let stop = false
	let hit!: () => void
	const reached = new Promise<void>((resolve) => {
		hit = resolve
	})
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://hub.test')
			const chunks: Uint8Array[] = []
			for await (const chunk of request) chunks.push(chunk)
			const headers = new Headers()
			for (const [name, value] of Object.entries(request.headers)) {
				if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
			}
			const body = chunks.length === 0 ? undefined : Buffer.concat(chunks)
			const reply = await app.request(`${url.pathname.slice('/store'.length)}${url.search}`, {
				method: request.method,
				headers,
				body
			})
			if (
				!stop &&
				request.method === fault.method &&
				fault.path.test(url.pathname) &&
				(fault.body === undefined || body?.includes(fault.body))
			) {
				stop = true
				hit()
				return
			}
			response.writeHead(reply.status, Object.fromEntries(reply.headers))
			response.end(Buffer.from(await reply.arrayBuffer()))
		} catch (error) {
			response.writeHead(500)
			response.end(error instanceof Error ? error.message : String(error))
		}
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as AddressInfo).port
	return { fs, origin: `http://127.0.0.1:${port}`, reached }
}

function syncScript(work: string): string {
	return `
		import { createNativeStorage } from ${JSON.stringify(new URL('./fs.ts', import.meta.url).href)}
		const storage = await createNativeStorage({
			supportDir: process.env.FRIEREN_SUPPORT_DIR,
			ownerId: 'user-a',
			getToken: async () => 'token-a',
			origin: process.env.TEST_STORE_ORIGIN,
			interval: 60000
		})
		${work}
		await new Promise(() => {})
	`
}

async function crash(process: ChildProcessWithoutNullStreams): Promise<void> {
	process.kill('SIGKILL')
	await new Promise((resolve) => process.once('exit', resolve))
}

async function output(child: ChildProcessWithoutNullStreams, expected: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout = ''
		let stderr = ''
		const clean = (): void => {
			clearTimeout(timeout)
			child.stdout.off('data', onStdout)
			child.stderr.off('data', onStderr)
			child.off('exit', onExit)
		}
		const onStdout = (data: Buffer): void => {
			stdout += data
			if (!stdout.includes(expected)) return
			clean()
			resolve(stdout)
		}
		const onStderr = (data: Buffer): void => {
			stderr += data
		}
		const onExit = (code: number | null): void => {
			clean()
			reject(new Error(`child exited ${code} before ${expected}\n${stdout}\n${stderr}`))
		}
		const timeout = setTimeout(() => {
			clean()
			reject(new Error(`timed out waiting for ${expected}\n${stdout}\n${stderr}`))
		}, 10_000)
		child.stdout.on('data', onStdout)
		child.stderr.on('data', onStderr)
		child.once('exit', onExit)
	})
}

test('reopens after a crash during a local Store write', async () => {
	const support = await temp()
	const script = `
		import { createNativeStorage } from ${JSON.stringify(new URL('./fs.ts', import.meta.url).href)}
		const storage = await createNativeStorage({
			supportDir: process.env.FRIEREN_SUPPORT_DIR,
			ownerId: null
		})
		const bytes = new TextEncoder().encode('write in flight')
		const digest = crypto.subtle.digest.bind(crypto.subtle)
		Object.defineProperty(crypto.subtle, 'digest', {
			configurable: true,
			value: async (algorithm, data) => {
				const value = new Uint8Array(data)
				if (value.length === bytes.length && value.every((byte, index) => byte === bytes[index])) {
					console.log('__WRITE_BLOCKED__')
					await new Promise(() => {})
				}
				return digest(algorithm, data)
			}
		})
		void storage.volume.writeFile('/note.txt', bytes)
		await new Promise(() => {})
	`
	const process = child(script, support)
	await output(process, '__WRITE_BLOCKED__')
	await crash(process)

	const storage = await createNativeStorage({ supportDir: support, ownerId: null })
	try {
		await storage.volume.writeFile('/after.txt', new TextEncoder().encode('after restart'))
		expect(new TextDecoder().decode(await storage.volume.readFile('/after.txt'))).toBe(
			'after restart'
		)
	} finally {
		await storage.close()
	}
})

test('recovers when the daemon crashes after a pushed page commits', async () => {
	const support = await temp()
	const hub = await backend({ method: 'POST', path: /\/commit$/, body: 'once.txt' })
	const process = child(
		syncScript(`
			await storage.flush()
			await storage.volume.writeFile('/once.txt', new TextEncoder().encode('once'))
			await storage.flush()
		`),
		support,
		{ TEST_STORE_ORIGIN: hub.origin }
	)
	await hub.reached
	await crash(process)

	const storage = await createNativeStorage({
		supportDir: support,
		ownerId: 'user-a',
		getToken: async () => 'token-a',
		origin: hub.origin
	})
	try {
		expect(await storage.flush()).toBe(true)
		expect(dec.decode(await hub.fs.readFile('/once.txt'))).toBe('once')
		expect((await hub.fs.readdir('/')).filter((entry) => entry.name === 'once.txt')).toHaveLength(1)
	} finally {
		await storage.close()
	}
})

test('recovers when the daemon crashes during pull', async () => {
	const support = await temp()
	const hub = await backend({ method: 'GET', path: /\/since$/ })
	await hub.fs.writeFile('/remote.txt', enc.encode('remote'))
	const process = child(syncScript('await storage.flush()'), support, {
		TEST_STORE_ORIGIN: hub.origin
	})
	await hub.reached
	await crash(process)

	const storage = await createNativeStorage({
		supportDir: support,
		ownerId: 'user-a',
		getToken: async () => 'token-a',
		origin: hub.origin
	})
	try {
		expect(await storage.flush()).toBe(true)
		expect(dec.decode(await storage.volume.readFile('/remote.txt'))).toBe('remote')
	} finally {
		await storage.close()
	}
})

test('recovers when the network stops during a blob upload', async () => {
	const support = await temp()
	const hub = await backend({ method: 'PUT', path: /\/blob\// })
	const process = child(
		syncScript(`
			await storage.flush()
			await storage.volume.writeFile('/large.bin', new Uint8Array(65 * 1024).fill(7))
			await storage.flush()
		`),
		support,
		{ TEST_STORE_ORIGIN: hub.origin }
	)
	await hub.reached
	await crash(process)

	const storage = await createNativeStorage({
		supportDir: support,
		ownerId: 'user-a',
		getToken: async () => 'token-a',
		origin: hub.origin
	})
	try {
		expect(await storage.flush()).toBe(true)
		expect(await hub.fs.readFile('/large.bin')).toEqual(new Uint8Array(65 * 1024).fill(7))
	} finally {
		await storage.close()
	}
})

test.skipIf(process.platform !== 'darwin')(
	'a new user closes open app sockets before the old volume is removed',
	async () => {
		const support = await temp()
		const script = `
			import { readFile } from 'node:fs/promises'
			import { join } from 'node:path'
			import { startDaemon } from ${JSON.stringify(new URL('./main.ts', import.meta.url).href)}
			import { getKernel } from ${JSON.stringify(new URL('./kernel.ts', import.meta.url).href)}
			const support = process.env.FRIEREN_SUPPORT_DIR
			let publish = () => {}
			const identity = {
				getToken: async () => null,
				signIn: async () => { throw new Error('not used') },
				signOut: async () => {},
				currentUser: async () => null,
				ownerId: async () => null,
				onChange(listener) {
					publish = listener
					return () => { publish = () => {} }
				}
			}
			const daemon = await startDaemon({
				port: 0,
				projectApps: async () => {},
				identity,
				terminate: () => console.log('__TERMINATED__')
			})
			if (!daemon) throw new Error('daemon lock unavailable')
			const apps = await (await getKernel()).list()
			if (!apps[0]) throw new Error('no app to open')
			const runtime = JSON.parse(await readFile(join(support, 'runtime.json'), 'utf8'))
			const socket = new WebSocket('ws://127.0.0.1:' + runtime.port + '/app/' + apps[0].id + '/connect')
			process.on('SIGUSR1', () => publish({ id: 'user-b' }))
			socket.onopen = () => console.log('__APP_OPEN__')
			socket.onclose = () => console.log('__APP_CLOSED__')
			await new Promise(() => {})
		`
		const process = spawn('bun', ['--eval', script], {
			cwd: import.meta.dirname,
			env: { ...globalThis.process.env, FRIEREN_SUPPORT_DIR: support }
		})
		children.push(process)
		await output(process, '__APP_OPEN__')
		const finishing = output(process, '__TERMINATED__')
		process.kill('SIGUSR1')
		const done = await finishing

		expect(done).toContain('__APP_CLOSED__')
		await expect(access(join(support, 'volume-v2'))).rejects.toThrow()
		await expect(access(join(support, 'runtime.json'))).rejects.toThrow()
	},
	20_000
)
