import { RecoveryError } from './conflict.internal'
import { versions } from './engine'
import { type Cursor, GuardError, type Node, ROOT, type Store, same, sha256Hex } from './store'
import { decodeNode, encodeNode, type WireNode } from './wire.internal'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const HIDDEN = 'sync-recovery-state'
export const RECOVERED = 'sync-recovered-items'
const MARKER = 'justfiles.recovery'

type Index = {
	operations: Record<string, string>
	settlements: Record<string, string>
	receipts: Record<string, true>
	verified: Record<string, true>
}

export type Operation = {
	key: string
	decision: string
	sources: WireNode[]
	targets: WireNode[]
	tombstones: WireNode[]
	copies: WireNode[]
}

export const pair = (row: Pick<Node, 'id' | 'version'>): string =>
	JSON.stringify([row.id, row.version])
export const hashKey = (value: string): Promise<string> => sha256Hex(encoder.encode(value))

/** Detached records hold manifests and receipts outside the user-editable forest. */
export async function recoveryState(store: Store, replica: string, remoteId: string) {
	const id = `sync-recovery-${await hashKey(JSON.stringify([replica, remoteId]))}`
	const mint = versions(replica)
	let cached: { row: Node; index: Index } | undefined
	const read = async (): Promise<{ row: Node; index: Index }> => {
		const row = await store.get(id)
		if (!row || row.deleted || row.parent !== HIDDEN || row.type !== 'file')
			throw new RecoveryError('required recovery state is unavailable')
		if (cached?.row.version === row.version && same(cached.row, row)) return cached
		const index = await readJSON<Index>(store, row)
		if (!index.operations || !index.settlements || !index.receipts || !index.verified)
			throw new RecoveryError('invalid recovery index')
		cached = { row, index }
		return cached
	}
	if (!(await store.get(id))) {
		await createJSON(
			store,
			id,
			{ operations: {}, settlements: {}, receipts: {}, verified: {} },
			mint
		)
	}
	await read()
	const update = async (change: (index: Index) => void): Promise<void> => {
		for (let attempt = 0; attempt < 64; attempt++) {
			const { row, index } = await read()
			const next = structuredClone(index)
			change(next)
			const value = await jsonRow(store, id, next, mint)
			try {
				await store.commit([value], [{ version: { id, is: row.version } }])
				cached = { row: value, index: next }
				return
			} catch (error) {
				if (!(error instanceof GuardError)) throw error
			}
		}
		throw new RecoveryError('recovery index is busy')
	}
	return {
		async verified(key: string): Promise<boolean> {
			return (await read()).index.verified[key] === true
		},
		async verify(key: string): Promise<void> {
			await update((index) => {
				index.verified[key] = true
			})
		},
		async adopted(row: Node): Promise<boolean> {
			return (await read()).index.receipts[pair(row)] === true
		},
		async receipts(rows: Node[]): Promise<void> {
			await update((index) => {
				for (const row of rows) index.receipts[pair(row)] = true
			})
		},
		async find(rows: Node[]): Promise<Operation | undefined> {
			const { index } = await read()
			for (const row of rows) {
				const key = index.settlements[pair(row)]
				if (key !== undefined) return this.load(key)
			}
			return undefined
		},
		async load(key: string): Promise<Operation | undefined> {
			const record = (await read()).index.operations[key]
			if (record === undefined) return undefined
			const row = await store.get(record)
			if (!row || row.deleted) throw new RecoveryError('required recovery operation is unavailable')
			const operation = await readJSON<Operation>(store, row)
			return operation
		},
		async save(operation: Operation, alias?: string): Promise<Operation> {
			const record = `${id}-${operation.key}`
			await createJSON(store, record, operation, mint)
			const row = await store.get(record)
			if (!row) throw new RecoveryError('recovery operation was not stored')
			const saved = await readJSON<Operation>(store, row)
			await update((index) => {
				index.operations[saved.key] = record
				if (alias !== undefined) index.operations[alias] = record
				for (const row of saved.tombstones) index.settlements[pair(row)] = saved.key
			})
			return saved
		},
		async root(): Promise<Node> {
			const held = await store.get(RECOVERED)
			if (held) {
				if (
					held.deleted ||
					held.type !== 'dir' ||
					held.parent !== ROOT ||
					decoder.decode(held.xattrs?.[MARKER]) !== '1'
				)
					throw new RecoveryError('recovery root is occupied or changed')
				return held
			}
			let name = 'Recovered items'
			for (let n = 2; await store.child(ROOT, name); n++) name = `Recovered items (${n})`
			const root = node(RECOVERED, ROOT, name, mint())
			root.xattrs = { [MARKER]: encoder.encode('1') }
			try {
				await store.commit(
					[root],
					[{ version: { id: RECOVERED, is: null } }, { free: { parent: ROOT, name } }]
				)
			} catch (error) {
				if (!(error instanceof GuardError)) throw error
				if (await store.get(RECOVERED)) return this.root()
				throw error
			}
			return root
		}
	}
}

export type RecoveryState = Awaited<ReturnType<typeof recoveryState>>

export function node(id: string, parent: string, name: string, version: string): Node {
	return { id, parent, name, version, type: 'dir', mode: 0o40700, size: 0n, mtimeNs: 0n }
}

async function jsonRow(
	store: Store,
	id: string,
	value: unknown,
	mint: () => string
): Promise<Node> {
	const bytes = encoder.encode(JSON.stringify(value))
	const content = await sha256Hex(bytes)
	await store.blobs.put(content, bytes)
	await bytesFor(store, content)
	return {
		...node(id, HIDDEN, id, mint()),
		type: 'file',
		mode: 0o100600,
		size: BigInt(bytes.length),
		content
	}
}

async function createJSON(
	store: Store,
	id: string,
	value: unknown,
	mint: () => string
): Promise<void> {
	if (await store.get(id)) return
	const row = await jsonRow(store, id, value, mint)
	try {
		await store.commit([row], [{ version: { id, is: null } }])
	} catch (error) {
		if (!(error instanceof GuardError)) throw error
	}
}

async function readJSON<T>(store: Store, row: Node): Promise<T> {
	if (!row.content) throw new RecoveryError('recovery record has no content')
	return JSON.parse(decoder.decode(await bytesFor(store, row.content))) as T
}

export async function bytesFor(store: Store, hash: string): Promise<Uint8Array> {
	const bytes = await store.blobs.get(hash)
	if (!bytes || (await sha256Hex(bytes)) !== hash)
		throw new RecoveryError(`recovery bytes unavailable or corrupt: ${hash}`)
	return bytes
}

/** Bound total feed work, including repeated versions while writers move rows. */
export async function scan(store: Store, limit = 100_000): Promise<Node[]> {
	const rows = new Map<string, Node>()
	let cursor: Cursor | undefined
	let scanned = 0
	for (;;) {
		const page = await store.since(cursor)
		scanned += page.nodes.length
		if (scanned > limit) throw new RecoveryError('recovery scan limit exceeded')
		for (const row of page.nodes) rows.set(row.id, row)
		if (page.next === undefined || page.nodes.length === 0) return [...rows.values()]
		if (page.next === cursor) throw new RecoveryError('recovery feed did not advance')
		cursor = page.next
	}
}

export const encodeRows = (rows: Node[]): WireNode[] => rows.map(encodeNode)
export const decodeRows = (rows: WireNode[]): Node[] => rows.map(decodeNode)
