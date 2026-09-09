import { RecoveryError, type SyncConflict, SyncConflictError } from './conflict.internal'
import { versions } from './engine'
import { BootstrapRequiredError } from './peer'
import { repair } from './recovery.semantic.internal'
import {
	bytesFor,
	decodeRows,
	encodeRows,
	hashKey,
	node,
	type Operation,
	pair,
	RECOVERED,
	type RecoveryState,
	scan
} from './recovery.state.internal'
import {
	ForeignCursorError,
	GuardError,
	type Node,
	ROOT,
	type Store,
	same,
	sha256Hex
} from './store'

type Decision =
	| 'revive'
	| 'ancestors'
	| 'rename'
	| 'root'
	| 'branch'
	| 'replacement'
	| 'cycle'
	| 'graph'
	| 'unresolved'

/** Ordered policy over the refusal alone; storage and retries belong to recover. */
export function decide(facts: SyncConflict): Decision {
	switch (facts.kind) {
		case 'deleted-id':
			return 'revive'
		case 'deleted-parent':
			return 'ancestors'
		case 'duplicate-name':
		case 'taken-name':
			return 'rename'
		case 'invalid-root':
			return 'root'
		case 'invalid-parent':
			return 'branch'
		case 'has-children':
			return 'replacement'
		case 'parent-cycle':
			return 'cycle'
		case 'structural':
			return 'graph'
		default:
			return 'unresolved'
	}
}

export function fingerprint(conflict: SyncConflict, rows: Node[]): string {
	return JSON.stringify([
		conflict.kind,
		[conflict.trigger.id, conflict.trigger.parent, conflict.trigger.version],
		conflict.authority.map(({ id, row }) => [id, row?.version ?? null]).sort(),
		rows.map((row) => [row.id, row.version]).sort()
	])
}

type Input = {
	local: Store
	remote: Store
	rows: Node[]
	conflict: SyncConflict
	replica: string
	recovery?: Store
	state?: RecoveryState
	scanLimit?: number
}
type Result = { status: 'applied' | 'raced' } | { status: 'failed'; error: RecoveryError }

/** Preserve before any shared write; durable plans make each subsequent step replayable. */
export async function recover(input: Input): Promise<Result> {
	try {
		return { status: await attempt(input) }
	} catch (error) {
		if (error instanceof BootstrapRequiredError || error instanceof ForeignCursorError) throw error
		if (error instanceof GuardError && !(error instanceof SyncConflictError))
			return { status: 'raced' }
		return {
			status: 'failed',
			error:
				error instanceof RecoveryError
					? error
					: new RecoveryError('sync recovery failed', { cause: error })
		}
	}
}

async function attempt(input: Input): Promise<'applied' | 'raced'> {
	const { local, remote, rows, conflict, replica, recovery, state } = input
	if (conflict.kind === 'settlement-has-children')
		throw new RecoveryError('settlement-has-children')
	let resumed = await state?.find(conflict.authority.flatMap(({ row }) => (row ? [row] : [])))
	let decision = resumed ? (resumed.decision as Decision) : decide(conflict)
	if (!resumed && (decision === 'revive' || decision === 'ancestors' || decision === 'rename')) {
		try {
			const changed = await repair(
				local,
				remote,
				rows,
				replica,
				state ? (rows) => state.receipts(rows) : undefined,
				async (row) => {
					const operation = await state?.find([row])
					if (operation) throw new ResumeSettlement(operation)
				}
			)
			return changed ? 'applied' : 'raced'
		} catch (error) {
			if (!(error instanceof ResumeSettlement)) throw error
			resumed = error.operation
			decision = resumed.decision as Decision
		}
	}
	if (!recovery || !state) throw new RecoveryError('preservation requires private recovery storage')
	const all = await scan(local, input.scanLimit)
	const roots = resumed
		? decodeRows(resumed.sources).map((row) => row.id)
		: decision === 'unresolved'
			? rows.map((row) => row.id)
			: [conflict.trigger.id]
	const sources = select(all, roots, decision !== 'root' && decision !== 'replacement')
	if (sources.length === 0) return 'raced'
	const key = await hashKey(
		JSON.stringify([fingerprint(conflict, rows), decision, sources.map(pair)])
	)
	let operation =
		resumed && equalSources(sources, decodeRows(resumed.sources)) ? resumed : await state.load(key)
	if (!operation) {
		const mint = versions(replica)
		const targets: Node[] = []
		const tombstones: Node[] = []
		for (const source of sources) {
			// Every selected id is read, including descendants absent from the refusal.
			const observed = await remote.get(source.id)
			const target = observed ?? { ...source, deleted: true as const, version: mint() }
			targets.push(target)
			if (!observed) tombstones.push(target)
		}
		await state.root()
		operation = await state.save({
			key,
			decision,
			sources: encodeRows(sources),
			targets: encodeRows(targets),
			tombstones: encodeRows(tombstones),
			copies: encodeRows(forest(sources, mint))
		})
	}
	// A null guard may have lost on a descendant that the next refusal still omits.
	// Give that arrival a fresh observation rather than retrying the old absence forever.
	let stale = false
	for (const planned of decodeRows(operation.tombstones)) {
		const held = await remote.get(planned.id)
		if (held !== null && !same(held, planned)) stale = true
	}
	if (stale) {
		const planned = new Map(decodeRows(operation.tombstones).map((row) => [row.id, row]))
		const targets: Node[] = []
		const tombstones: Node[] = []
		for (const source of sources) {
			const observed = await remote.get(source.id)
			const target = observed ?? planned.get(source.id)
			if (!target) throw new RecoveryError('missing planned settlement')
			targets.push(target)
			if (!observed) tombstones.push(target)
		}
		operation = await state.save(
			{
				...operation,
				key: await hashKey(JSON.stringify([key, targets.map(pair)])),
				targets: encodeRows(targets),
				tombstones: encodeRows(tombstones)
			},
			key
		)
	}
	await state.root()
	// A changed copy belongs to the user. Start a new attempt without overwriting it.
	if (await changedCopy(recovery, operation, await state.verified(operation.copies[0]?.id ?? ''))) {
		operation = await state.save(
			{
				...operation,
				key: await hashKey(`${operation.key}:${crypto.randomUUID()}`),
				copies: encodeRows(forest(sources, versions(replica)))
			},
			key
		)
	}
	await preserve(local, remote, recovery, operation)
	await state.verify(operation.copies[0]?.id ?? '')
	const tombstones = decodeRows(operation.tombstones)
	const pending: Node[] = []
	for (const row of tombstones) {
		const held = await remote.get(row.id)
		if (held === null) pending.push(row)
		else if (!same(held, row)) return 'raced'
	}
	if (pending.length > 0) {
		try {
			await remote.commit(
				pending,
				pending.map((row) => ({ version: { id: row.id, is: null } }))
			)
		} catch (error) {
			if (error instanceof SyncConflictError && error.conflict.kind === 'settlement-has-children')
				throw new RecoveryError('settlement-has-children', { cause: error })
			throw error
		}
	}
	const targets = decodeRows(operation.targets)
	await state.receipts(targets)
	await local.commit(
		targets,
		sources.map((row) => ({ version: { id: row.id, is: row.version } }))
	)
	return 'applied'
}

function select(all: Node[], roots: string[], descendants: boolean): Node[] {
	const ids = new Set(roots)
	if (descendants) {
		const children = new Map<string, string[]>()
		for (const row of all) {
			const siblings = children.get(row.parent) ?? []
			siblings.push(row.id)
			children.set(row.parent, siblings)
		}
		const queue = [...ids]
		for (let i = 0; i < queue.length; i++) {
			for (const id of children.get(queue[i] ?? '') ?? []) {
				if (!ids.has(id)) {
					ids.add(id)
					queue.push(id)
				}
			}
		}
	}
	return all
		.filter((row) => ids.has(row.id))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const equalSources = (a: Node[], b: Node[]): boolean =>
	a.length === b.length &&
	a.every((row, i) => b[i] !== undefined && row.id === b[i]?.id && same(row, b[i] as Node))

/** Make every malformed component reachable, retaining original fields in the manifest. */
function forest(sources: Node[], mint: () => string): Node[] {
	const root = node(crypto.randomUUID(), RECOVERED, `Recovery ${crypto.randomUUID()}`, mint())
	const live = sources.filter((row) => !row.deleted)
	const byId = new Map(live.map((row) => [row.id, row]))
	const ids = new Map(live.map((row) => [row.id, crypto.randomUUID()]))
	const parents = new Map(
		live.map((row) => [
			row.id,
			row.id !== ROOT && byId.get(row.parent)?.type === 'dir' ? row.parent : undefined
		])
	)
	const walked = new Set<string>()
	for (const row of live) {
		const chain: string[] = []
		const positions = new Map<string, number>()
		let at: string | undefined = row.id
		while (at !== undefined && !walked.has(at)) {
			const start = positions.get(at)
			if (start !== undefined) {
				const lowest = chain.slice(start).sort()[0]
				if (lowest !== undefined) parents.set(lowest, undefined)
				break
			}
			positions.set(at, chain.length)
			chain.push(at)
			at = parents.get(at)
		}
		for (const id of chain) walked.add(id)
	}
	const names = new Set<string>()
	const numbers = new Map<string, number>()
	return [
		root,
		...live.map((row) => {
			const parent = ids.get(parents.get(row.id) ?? '') ?? root.id
			const base = row.name || 'Root'
			let name = base
			const key = JSON.stringify([parent, base])
			let n = numbers.get(key) ?? 2
			while (names.has(JSON.stringify([parent, name]))) name = `${base} (${n++})`
			numbers.set(key, n)
			names.add(JSON.stringify([parent, name]))
			return { ...row, id: ids.get(row.id) as string, parent, name, version: mint() }
		})
	]
}

async function changedCopy(
	store: Store,
	operation: Operation,
	verified: boolean
): Promise<boolean> {
	for (const row of decodeRows(operation.copies)) {
		const held = await store.get(row.id)
		if (held ? !same(held, row) : verified) return true
	}
	return false
}

async function preserve(
	local: Store,
	remote: Store,
	recovery: Store,
	operation: Operation
): Promise<void> {
	const copies = decodeRows(operation.copies)
	for (const row of copies) {
		if (row.type === 'file' && row.size > 0n && !row.content)
			throw new RecoveryError('source file has no content hash')
		if (row.content) {
			const bytes =
				(await recovery.blobs.get(row.content)) ??
				(await local.blobs.get(row.content)) ??
				(await remote.blobs.get(row.content))
			if (!bytes || (await sha256Hex(bytes)) !== row.content)
				throw new RecoveryError(`source bytes unavailable: ${row.id}`)
			await recovery.blobs.put(row.content, bytes)
		}
	}
	const missing: Node[] = []
	for (const row of copies) {
		const held = await recovery.get(row.id)
		if (held === null) missing.push(row)
		else if (!same(held, row)) throw new RecoveryError('recovered copy changed during preservation')
	}
	if (missing.length)
		await recovery.commit(
			missing,
			missing.map((row) => ({ version: { id: row.id, is: null } }))
		)
	for (const row of copies) {
		const held = await recovery.get(row.id)
		if (!held || !same(held, row)) throw new RecoveryError('recovered row failed verification')
		if (row.content) await bytesFor(recovery, row.content)
	}
}

/** Semantic repair can discover an interrupted settlement beyond the refusal's facts. */
class ResumeSettlement extends Error {
	readonly operation: Operation

	constructor(operation: Operation) {
		super('resume recorded settlement')
		this.operation = operation
	}
}
