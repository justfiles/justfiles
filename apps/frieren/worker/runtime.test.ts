import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
	clearReset,
	createSqliteAdapter,
	type DbAdapter,
	type ResetBody,
	type ResetDecision,
	readGenerationState,
	resetVolume,
	sqliteStorage
} from '@justfiles/core'
import { type Storage, volume } from '@justfiles/fs'
import { StaleLifetimeError } from '@justfiles/lifetime'
import { describe, expect, test, vi } from 'vitest'
import { createRuntimeHost, createSerialExecutor } from './runtime'

const migrationsDir = new URL('../../../packages/core/src/migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((file) => file.endsWith('.sql'))
	.sort()
	.map((file) => readFileSync(new URL(file, migrationsDir), 'utf8'))
	.join('\n')
const bytes = (value: string) => new TextEncoder().encode(value)
const text = (value: Uint8Array) => new TextDecoder().decode(value)

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function makeDb(): { db: DbAdapter; storage: Storage } {
	const raw = new DatabaseSync(':memory:')
	raw.exec(schema)
	const db64 = {
		prepare(sql: string) {
			const statement = raw.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => raw.exec(sql)
	}
	const db = createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
	return { db, storage: sqliteStorage(db) }
}

type Resource = { kind: 'session' | 'apps' | 'kernel'; generation: number; id: number }
type ApplyReset = (request: Exclude<ResetBody, { mode: 'complete' }>) => Promise<ResetDecision>

async function testHost(
	storage: Storage,
	db: DbAdapter,
	options: {
		executor?: ReturnType<typeof createSerialExecutor>
		apply?: ApplyReset
		ready?: (generation: number) => Promise<void>
	} = {}
) {
	let nextId = 0
	const disposed: Resource[] = []
	const executor = options.executor ?? createSerialExecutor()
	const ready = options.ready
	const host = createRuntimeHost<Resource, Resource, Resource>({
		storage,
		generation: (await readGenerationState(db)).generation,
		executor,
		reset: {
			read: () => readGenerationState(db),
			apply: options.apply ?? ((request) => resetVolume(db, request)),
			clear: (resetId) => clearReset(db, resetId)
		},
		factories: {
			ready: ready ? (scope) => ready(scope.lifetime.value) : undefined,
			session: (scope) => ({
				kind: 'session',
				generation: scope.lifetime.value,
				id: ++nextId
			}),
			apps: (scope) => ({ kind: 'apps', generation: scope.lifetime.value, id: ++nextId }),
			kernel: (scope) => ({ kind: 'kernel', generation: scope.lifetime.value, id: ++nextId }),
			disposeSession: (resource) => disposed.push(resource),
			disposeApps: (resource) => disposed.push(resource),
			disposeKernel: (resource) => disposed.push(resource)
		}
	})
	return { host, executor, disposed }
}

describe('generation-scoped runtime', () => {
	test('rejects a read result that finishes after reset invalidates its scope', async () => {
		const { db, storage } = makeDb()
		await volume(storage).writeFile('/old', bytes('old'))
		const started = deferred()
		const release = deferred()
		const delayed: Storage = {
			...storage,
			async getBlob(ino) {
				const result = await storage.getBlob(ino)
				started.resolve()
				await release.promise
				return result
			}
		}
		const { host } = await testHost(delayed, db)

		const read = host.current().volume.readFile('/old')
		await started.promise
		await host.reset({ mode: 'wipe', fromGeneration: 1 })
		release.resolve()

		await expect(read).rejects.toBeInstanceOf(StaleLifetimeError)
	})

	test('lets an old mutation finish before a reset queued behind it', async () => {
		const { db, storage } = makeDb()
		await volume(storage).writeFile('/old', bytes('before'))
		const started = deferred()
		const release = deferred()
		const delayed: Storage = {
			...storage,
			async putBlob(ino, data, options) {
				started.resolve()
				await release.promise
				return storage.putBlob(ino, data, options)
			}
		}
		const { host } = await testHost(delayed, db)

		const write = host.current().volume.writeFile('/old', bytes('finished'))
		await started.promise
		const reset = host.reset({ mode: 'wipe', fromGeneration: 1 })
		release.resolve()

		await expect(write).resolves.toBeUndefined()
		await expect(reset).resolves.toEqual({ ok: true, generation: 2 })
		expect(await volume(storage).exists('/old')).toBe(false)
	})

	test('makes an old mutation fail before it can enter a new tree', async () => {
		const { db, storage } = makeDb()
		const applying = deferred()
		const release = deferred()
		const { host } = await testHost(storage, db, {
			apply: async (request) => {
				applying.resolve()
				await release.promise
				return resetVolume(db, request)
			}
		})
		const old = host.current()

		const reset = host.reset({ mode: 'wipe', fromGeneration: 1 })
		await applying.promise
		expect(() => old.volume.writeFile('/late', bytes('wrong tree'))).toThrow(StaleLifetimeError)
		release.resolve()

		await expect(reset).resolves.toEqual({ ok: true, generation: 2 })
		expect(await volume(storage).exists('/late')).toBe(false)
	})

	test('leaves the current scope and all resources usable after a failed CAS', async () => {
		const { db, storage } = makeDb()
		const { host, disposed } = await testHost(storage, db)
		const current = host.current()
		const resources = [current.session(), current.apps(), current.kernel()]

		await expect(host.reset({ mode: 'wipe', fromGeneration: 0 })).resolves.toEqual({
			ok: false,
			error: 'generation_stale',
			generation: 1
		})

		expect(host.current()).toBe(current)
		expect([current.session(), current.apps(), current.kernel()]).toEqual(resources)
		expect(disposed).toEqual([])
		await expect(current.volume.exists('/')).resolves.toBe(true)
	})

	test('publishes fresh session, apps, and kernel owners before releasing reset', async () => {
		const { db, storage } = makeDb()
		const { host, executor, disposed } = await testHost(storage, db)
		const old = host.current()
		const oldResources = [old.session(), old.apps(), old.kernel()]

		const reset = host.reset({ mode: 'wipe', fromGeneration: 1 })
		const afterReset = executor.run(async () => {
			const scope = host.current()
			return [scope, scope.session(), scope.apps(), scope.kernel()] as const
		})

		await expect(reset).resolves.toEqual({ ok: true, generation: 2 })
		const [scope, ...resources] = await afterReset
		expect(scope).not.toBe(old)
		expect(resources.every((resource) => resource.generation === 2)).toBe(true)
		expect(resources.every((resource) => !oldResources.includes(resource))).toBe(true)
		expect(disposed).toHaveLength(3)
		expect(disposed).toEqual(expect.arrayContaining(oldResources))
	})

	test('reconstructs from durable generation when apply fails after invalidation', async () => {
		const { db, storage } = makeDb()
		const { host } = await testHost(storage, db, {
			apply: async (request) => {
				await resetVolume(db, request)
				throw new Error('lost response after commit')
			}
		})
		const old = host.current()

		await expect(host.reset({ mode: 'wipe', fromGeneration: 1 })).rejects.toThrow(
			'lost response after commit'
		)
		expect(host.current()).not.toBe(old)
		expect(host.current().lifetime.value).toBe(2)
		await expect(host.current().volume.exists('/')).resolves.toBe(true)
	})

	test('complete keeps the scope and ordinary change events invalidate its caches', async () => {
		const { db, storage } = makeDb()
		const raw = volume(storage)
		await raw.writeFile('/file', bytes('old'))
		const { host } = await testHost(storage, db)
		const current = host.current()
		expect(text(await current.volume.readFile('/file'))).toBe('old')

		await raw.rm('/file')
		await raw.writeFile('/file', bytes('republished'))
		await expect(host.reset({ mode: 'complete', resetId: 'r1' })).resolves.toEqual({
			ok: true,
			generation: 1
		})

		expect(host.current()).toBe(current)
		expect(text(await current.volume.readFile('/file'))).toBe('republished')
	})

	test('retries stale readiness against the newly published scope', async () => {
		const { db, storage } = makeDb()
		const firstReady = deferred()
		const release = deferred()
		const generations: number[] = []
		const { host } = await testHost(storage, db, {
			ready: async (generation) => {
				generations.push(generation)
				if (generation === 1) {
					firstReady.resolve()
					await release.promise
				}
			}
		})

		const ready = host.ready()
		await firstReady.promise
		await host.reset({ mode: 'wipe', fromGeneration: 1 })
		release.resolve()

		await expect(ready).resolves.toBe(host.current())
		expect(generations).toEqual([1, 2])
	})

	test('disposes watches and a fresh host at the same generation is independent', async () => {
		const { db, storage } = makeDb()
		const { host } = await testHost(storage, db)
		const listener = vi.fn()
		await host.current().volume.watch('/watched', listener)
		await host.reset({ mode: 'wipe', fromGeneration: 1 })
		await host.current().volume.writeFile('/watched', bytes('new'))
		expect(listener).not.toHaveBeenCalled()

		const second = await testHost(storage, db)
		expect(second.host.current().lifetime.value).toBe(2)
		await expect(second.host.current().volume.readFile('/watched')).resolves.toEqual(bytes('new'))
	})
})
