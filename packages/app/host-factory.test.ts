import { expect, test } from 'bun:test'
import type { CalendarCapability } from './capabilities/calendar/contract.js'
import type { EmailCapability, EmailDetail, EmailSummary } from './capabilities/email/contract.js'
import { APP_CONTRACT_VERSION, type Capabilities, NotFoundError } from './contract.js'
import { type CreateHostOptions, createHost, type VolumeBackend } from './host-factory.js'

function memBackend(): VolumeBackend & { files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>()
	return {
		files,
		async readFile(path) {
			const v = files.get(path)
			if (!v) throw new Error(`ENOENT: ${path}`)
			return v
		},
		async writeFile(path, data) {
			files.set(path, data)
		},
		async mkdir() {}
	}
}

function stubCapabilities(): Capabilities {
	const reject = () => Promise.reject(new Error('not implemented'))
	const email: EmailCapability = {
		listUnread: reject as EmailCapability['listUnread'],
		readDetail: reject as EmailCapability['readDetail'],
		markRead: reject as EmailCapability['markRead']
	}
	const calendar: CalendarCapability = {
		listToday: reject as CalendarCapability['listToday']
	}
	return { email, calendar }
}

function hostOpts(extra: Partial<CreateHostOptions> = {}): CreateHostOptions {
	return {
		appId: 'demo',
		volume: memBackend(),
		capabilities: stubCapabilities(),
		...extra
	}
}

test('createHost returns a Host with the contract version', () => {
	const host = createHost(hostOpts())
	expect(host.version).toBe(APP_CONTRACT_VERSION)
})

test('createHost yields a fresh instance per call', () => {
	const backend = memBackend()
	const a = createHost(hostOpts({ volume: backend }))
	const b = createHost(hostOpts({ volume: backend }))
	expect(a).not.toBe(b)
	expect(a.volume).not.toBe(b.volume)
})

test('volume.writeText/readText round-trip via the backend', async () => {
	const backend = memBackend()
	const host = createHost(hostOpts({ volume: backend }))
	await host.volume.writeText('greeting.txt', 'hello')
	expect(await host.volume.readText('greeting.txt')).toBe('hello')
})

test('volume scopes paths under /apps/<appId>/private/', async () => {
	const backend = memBackend()
	const host = createHost(hostOpts({ volume: backend }))
	await host.volume.writeText('a/b.txt', 'x')
	expect([...backend.files.keys()]).toEqual(['/apps/demo/private/a/b.txt'])
})

test('two mounts of the same app id do not see each other when backends differ', async () => {
	const a = createHost(hostOpts())
	const b = createHost(hostOpts())
	await a.volume.writeText('shared.txt', 'from-a')
	await expect(b.volume.readText('shared.txt')).rejects.toThrow(NotFoundError)
})

test('two mounts with different app ids do not collide on the same backend', async () => {
	const backend = memBackend()
	const a = createHost(hostOpts({ appId: 'one', volume: backend }))
	const b = createHost(hostOpts({ appId: 'two', volume: backend }))
	await a.volume.writeText('shared.txt', 'from-a')
	await b.volume.writeText('shared.txt', 'from-b')
	expect(await a.volume.readText('shared.txt')).toBe('from-a')
	expect(await b.volume.readText('shared.txt')).toBe('from-b')
})

test('volume.readText throws NotFoundError when the file does not exist', async () => {
	const host = createHost(hostOpts())
	await expect(host.volume.readText('missing.txt')).rejects.toThrow(NotFoundError)
})

test('volume rejects path-escape attempts', async () => {
	const host = createHost(hostOpts())
	await expect(host.volume.readText('../escape.txt')).rejects.toThrow(/not allowed/)
	await expect(host.volume.readText('')).rejects.toThrow(/non-empty/)
})

test('volume propagates non-ENOENT backend errors verbatim', async () => {
	const backend: VolumeBackend = {
		async readFile() {
			throw new Error('disk on fire')
		},
		async writeFile() {},
		async mkdir() {}
	}
	const host = createHost(hostOpts({ volume: backend }))
	await expect(host.volume.readText('x.txt')).rejects.toThrow('disk on fire')
})

test('host.capabilities.email dispatches to the broker with the original arguments', async () => {
	const calls: { method: string; input: unknown }[] = []
	const summary: EmailSummary = {
		id: 'a',
		from: 'x',
		subject: 'y',
		receivedAt: 0,
		unread: true
	}
	const email: EmailCapability = {
		async listUnread(input) {
			calls.push({ method: 'listUnread', input })
			return [summary]
		},
		async readDetail(input) {
			calls.push({ method: 'readDetail', input })
			return { ...summary, bodyText: 'b' } satisfies EmailDetail
		},
		async markRead(input) {
			calls.push({ method: 'markRead', input })
			return { success: true }
		}
	}
	const host = createHost(hostOpts({ capabilities: { ...stubCapabilities(), email } }))
	await expect(host.capabilities.email.listUnread({ limit: 5 })).resolves.toEqual([summary])
	await host.capabilities.email.markRead({ id: 'a' })
	expect(calls).toEqual([
		{ method: 'listUnread', input: { limit: 5 } },
		{ method: 'markRead', input: { id: 'a' } }
	])
})

test('host.capabilities.calendar dispatches to the broker with the original arguments', async () => {
	const calls: unknown[] = []
	const calendar: CalendarCapability = {
		async listToday(input) {
			calls.push(input)
			return []
		}
	}
	const host = createHost(hostOpts({ capabilities: { ...stubCapabilities(), calendar } }))
	await host.capabilities.calendar.listToday({ timezone: 'UTC', now: 1 })
	expect(calls).toEqual([{ timezone: 'UTC', now: 1 }])
})

test('broker rejections propagate as thrown Error instances', async () => {
	const email: EmailCapability = {
		async listUnread() {
			throw new Error('upstream down')
		},
		async readDetail() {
			throw new Error('nope')
		},
		async markRead() {
			throw new Error('nope')
		}
	}
	const host = createHost(hostOpts({ capabilities: { ...stubCapabilities(), email } }))
	await expect(host.capabilities.email.listUnread({})).rejects.toThrow('upstream down')
})

test('two mounts receive independent capability surfaces', () => {
	const a = createHost(hostOpts())
	const b = createHost(hostOpts())
	expect(a.capabilities).not.toBe(b.capabilities)
})
