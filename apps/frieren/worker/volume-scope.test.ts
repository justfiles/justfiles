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
import { createVolumeScopeOwner } from './volume-scope'

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

type Resource = { kind: 'session' | 'apps'; generation: number; id: number }
type ApplyReset = (request: Exclude<ResetBody, { mode: 'complete' }>) => Promise<ResetDecision>

async function testOwner(
	storage: Storage,
	db: DbAdapter,
	options: {
		apply?: ApplyReset
		ready?: (generation: number) => Promise<void>
	} = {}
) {
	let nextId = 0
	const disposed: Resource[] = []
	const ready = options.ready
	const owner = createVolumeScopeOwner<Resource, Resource>({
		storage,
		generation: (await readGenerationState(db)).generation,
		reset: {
			read: () => readGenerationState(db),
			apply: options.apply ?? ((request) => resetVolume(db, request)),
			clear: (resetId) => clearReset(db, resetId)
		},
		factories: {
			ready: ready ? (scope) => ready(scope.generation) : undefined,
			session: (scope) => ({
				kind: 'session',
				generation: scope.generation,
				id: ++nextId
			}),
			apps: (scope) => ({ kind: 'apps', generation: scope.generation, id: ++nextId }),
			disposeSession: (resource) => disposed.push(resource),
			disposeApps: (resource) => disposed.push(resource)
		}
	})
	return { owner, disposed }
}

describe('volume scopes', () => {
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
		const { owner } = await testOwner(delayed, db)
		const scope = await owner.ready()

		const read = scope.volume.readFile('/old')
		await started.promise
		await owner.reset({ mode: 'wipe', fromGeneration: 1 })
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
		const { owner } = await testOwner(delayed, db)
		const scope = await owner.ready()

		const write = scope.volume.writeFile('/old', bytes('finished'))
		await started.promise
		const reset = owner.reset({ mode: 'wipe', fromGeneration: 1 })
		release.resolve()

		await expect(write).resolves.toBeUndefined()
		await expect(reset).resolves.toEqual({ ok: true, generation: 2 })
		expect(await volume(storage).exists('/old')).toBe(false)
	})

	test('makes an old mutation fail before it can enter a new tree', async () => {
		const { db, storage } = makeDb()
		const applying = deferred()
		const release = deferred()
		const { owner } = await testOwner(storage, db, {
			apply: async (request) => {
				applying.resolve()
				await release.promise
				return resetVolume(db, request)
			}
		})
		const old = await owner.ready()

		const reset = owner.reset({ mode: 'wipe', fromGeneration: 1 })
		await applying.promise
		expect(() => old.volume.writeFile('/late', bytes('wrong tree'))).toThrow(StaleLifetimeError)
		release.resolve()

		await expect(reset).resolves.toEqual({ ok: true, generation: 2 })
		expect(await volume(storage).exists('/late')).toBe(false)
	})

	test('leaves the current scope and all resources usable after a failed CAS', async () => {
		const { db, storage } = makeDb()
		const { owner, disposed } = await testOwner(storage, db)
		const current = await owner.ready()
		const resources = [current.session(), current.apps()]

		await expect(owner.reset({ mode: 'wipe', fromGeneration: 0 })).resolves.toEqual({
			ok: false,
			error: 'generation_stale',
			generation: 1
		})

		expect(await owner.ready()).toBe(current)
		expect([current.session(), current.apps()]).toEqual(resources)
		expect(disposed).toEqual([])
		await expect(current.volume.exists('/')).resolves.toBe(true)
	})

	test('publishes fresh session and apps owners before reset returns', async () => {
		const { db, storage } = makeDb()
		const { owner, disposed } = await testOwner(storage, db)
		const old = await owner.ready()
		const oldResources = [old.session(), old.apps()]

		await expect(owner.reset({ mode: 'wipe', fromGeneration: 1 })).resolves.toEqual({
			ok: true,
			generation: 2
		})
		const scope = await owner.ready()
		const resources = [scope.session(), scope.apps()]
		expect(scope).not.toBe(old)
		expect(resources.every((resource) => resource.generation === 2)).toBe(true)
		expect(resources.every((resource) => !oldResources.includes(resource))).toBe(true)
		expect(disposed).toHaveLength(2)
		expect(disposed).toEqual(expect.arrayContaining(oldResources))
	})

	test('reconstructs from durable generation when apply fails after invalidation', async () => {
		const { db, storage } = makeDb()
		const { owner } = await testOwner(storage, db, {
			apply: async (request) => {
				await resetVolume(db, request)
				throw new Error('lost response after commit')
			}
		})
		const old = await owner.ready()

		await expect(owner.reset({ mode: 'wipe', fromGeneration: 1 })).rejects.toThrow(
			'lost response after commit'
		)
		const current = await owner.ready()
		expect(current).not.toBe(old)
		expect(current.generation).toBe(2)
		await expect(current.volume.exists('/')).resolves.toBe(true)
	})

	test('complete keeps the scope and ordinary change events invalidate its caches', async () => {
		const { db, storage } = makeDb()
		const raw = volume(storage)
		await raw.writeFile('/file', bytes('old'))
		const { owner } = await testOwner(storage, db)
		const current = await owner.ready()
		expect(text(await current.volume.readFile('/file'))).toBe('old')

		await raw.rm('/file')
		await raw.writeFile('/file', bytes('republished'))
		await expect(owner.reset({ mode: 'complete', resetId: 'r1' })).resolves.toEqual({
			ok: true,
			generation: 1
		})

		expect(await owner.ready()).toBe(current)
		expect(text(await current.volume.readFile('/file'))).toBe('republished')
	})

	test('retries stale readiness against the newly published scope', async () => {
		const { db, storage } = makeDb()
		const firstReady = deferred()
		const release = deferred()
		const generations: number[] = []
		const { owner } = await testOwner(storage, db, {
			ready: async (generation) => {
				generations.push(generation)
				if (generation === 1) {
					firstReady.resolve()
					await release.promise
				}
			}
		})

		const ready = owner.ready()
		await firstReady.promise
		await owner.reset({ mode: 'wipe', fromGeneration: 1 })
		release.resolve()

		await expect(ready).resolves.toMatchObject({ generation: 2 })
		expect(generations).toEqual([1, 2])
	})

	test('disposes watches and a fresh owner at the same generation is independent', async () => {
		const { db, storage } = makeDb()
		const { owner } = await testOwner(storage, db)
		const old = await owner.ready()
		const listener = vi.fn()
		await old.volume.watch('/watched', listener)
		await owner.reset({ mode: 'wipe', fromGeneration: 1 })
		await (await owner.ready()).volume.writeFile('/watched', bytes('new'))
		expect(listener).not.toHaveBeenCalled()

		const second = await testOwner(storage, db)
		const current = await second.owner.ready()
		expect(current.generation).toBe(2)
		await expect(current.volume.readFile('/watched')).resolves.toEqual(bytes('new'))
	})
})
