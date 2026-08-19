import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { storageSyncReplica } from '@justfiles/sync'
import { ROOT_NODE_ID } from '@justfiles/sync/node'
import { expect, test } from 'vitest'
import type { DbAdapter } from './db'
import { createSqliteAdapter } from './db.sqlite'
import { readGenerationState, resetVolume } from './reset'
import { storage as sqliteStorage } from './storage.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((file) => file.endsWith('.sql'))
	.sort()
	.map((file) => readFileSync(new URL(file, migrationsDir), 'utf8'))
	.join('\n')

// Durable Object SQLite binds at most 100 parameters per statement and fails the
// statement with `too many SQL variables` above it. node:sqlite allows thousands, so
// the cap has to be imposed here or these paths pass in tests and break on the DO.
const DO_PARAM_CAP = 100

function capped(db: DbAdapter): DbAdapter {
	const check = (args: unknown[] = []) => {
		if (args.length > DO_PARAM_CAP) throw new Error('too many SQL variables')
	}
	const wrap = (current: DbAdapter): DbAdapter => ({
		query(statement, args) {
			check(args)
			return current.query(statement, args)
		},
		run(statement, args) {
			check(args)
			return current.run(statement, args)
		},
		transaction: (task) => current.transaction((tx) => task(wrap(tx)))
	})
	return wrap(db)
}

function open() {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const connection = {
		prepare(sql: string) {
			const statement = db.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => db.exec(sql)
	}
	const adapter = capped(
		createSqliteAdapter(connection as unknown as Parameters<typeof createSqliteAdapter>[0])
	)
	return { adapter, storage: sqliteStorage(adapter) }
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

// Every dynamic `IN`-list, exercised past the cap. The counts are what the callers
// really pass: a scan page is 200 rows, a snapshot page is whatever `limit` the peer
// asked for (500 from the sync engine), and one node operation carries every mutation
// of one apply.
const OVER_CAP = 150

async function seed(files: number) {
	const { adapter, storage } = open()
	const fs = volume(storage)
	await fs.mkdir('/project', { recursive: true })
	for (let index = 0; index < files; index++)
		await fs.writeFile(`/project/file-${index}.ts`, bytes(`export const x = ${index}\n`))
	return { adapter, storage, fs }
}

test('a recursive scan pages a volume wider than the parameter cap', async () => {
	const { fs } = await seed(OVER_CAP)
	const seen: string[] = []
	await fs.scan('/project', async (path) => {
		seen.push(path)
	})
	expect(new Set(seen).size).toBe(OVER_CAP + 1)
})

test('a sync snapshot page wider than the parameter cap still reads its xattrs', async () => {
	const { storage, fs } = await seed(OVER_CAP)
	await fs.setXattr('/project/file-7.ts', 'user.mark', bytes('yes'))
	const puts = await storage.sync?.pathSnapshot?.puts('', 500)
	expect(puts?.length).toBeGreaterThan(DO_PARAM_CAP)
	expect(puts?.find((change) => change.path === '/project/file-7.ts')).toMatchObject({
		meta: { xattrs: { 'user.mark': 'eWVz' } }
	})
})

test('a node operation with more mutations than the parameter cap appends', async () => {
	const { storage } = await seed(0)
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	const meta = { type: 1, mode: 0o755, mtimeNs: '0', size: '0' } as const
	const apply = (operationId: string, mutations: unknown[]) =>
		selected.replica.applyNodeOperations(
			[{ operationId, mutations } as never],
			() => Promise.reject(new Error('unexpected content request')),
			{ source: 'client-a' }
		)
	const nodes = Array.from({ length: OVER_CAP }, (_, index) => `node-${index}`)

	await apply(
		'op-create',
		nodes.map((nodeId, index) => ({
			kind: 'create',
			nodeId,
			parentId: ROOT_NODE_ID,
			name: `dir-${index}`,
			baseRevision: 0,
			revision: 1,
			meta
		}))
	)
	// An UPDATE of every node, twice: `append` compacts against the journal rows the
	// first pass wrote, which is what reads back every touched node (`node_id IN …`)
	// and then every referencing row (`seq IN …`).
	for (const [pass, operationId] of ['op-update-1', 'op-update-2'].entries())
		await apply(
			operationId,
			nodes.map((nodeId) => ({
				kind: 'update',
				nodeId,
				baseRevision: pass + 1,
				revision: pass + 2,
				meta
			}))
		)

	// `/project` from the seed, plus one directory per created node.
	expect((await volume(storage).readdir('/')).length).toBe(OVER_CAP + 1)
})

test('adopt-mine keeps a private tree wider than the parameter cap', async () => {
	const { adapter, fs } = await seed(0)
	await fs.mkdir('/.state/sync', { recursive: true })
	for (let index = 0; index < OVER_CAP; index++)
		await fs.writeFile(`/.state/sync/record-${index}.json`, bytes('{}'))
	await fs.writeFile('/public.txt', bytes('public'))

	// An adopt-mine must name the volume's own identity (see `decideReset`).
	const before = await readGenerationState(adapter)
	const decision = await resetVolume(adapter, {
		mode: 'adopt-mine',
		fromGeneration: before.generation,
		lineageId: before.lineageId,
		operationId: 'op-adopt'
	})

	expect(decision).toMatchObject({ ok: true, next: { generation: before.generation + 1 } })
	expect((await fs.readdir('/.state/sync')).length).toBe(OVER_CAP)
	await expect(fs.readFile('/public.txt')).rejects.toThrow()
})
