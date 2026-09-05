import { versions } from './engine'
import { type Guard, type Node, type NodeId, ROOT, type Store } from './store'

const SEP = String.fromCharCode(0)

export async function repair(
	local: Store,
	remote: Pick<Store, 'get' | 'child'>,
	rows: Node[],
	replica: string,
	receipt?: (rows: Node[]) => Promise<void>,
	deleted?: (row: Node) => Promise<void>
): Promise<boolean> {
	const mint = versions(replica)
	const fixes: Node[] = []
	const guards: Guard[] = []
	const revived = new Map<NodeId, NodeId>()
	const fix = (seen: Node, next: Node): void => {
		fixes.push(next)
		guards.push({ version: { id: seen.id, is: seen.version } })
	}
	const handed = new Set<string>()
	const keeps = new Map<string, NodeId>()
	for (const row of rows) {
		if (row.deleted) continue
		const key = row.parent + SEP + row.name
		const best = keeps.get(key)
		if (best === undefined || row.id < best) keeps.set(key, row.id)
	}
	const free = async (row: Node): Promise<string> => {
		const taken = async (name: string): Promise<boolean> => {
			if (handed.has(row.parent + SEP + name)) return true
			if (await remote.child(row.parent, name)) return true
			const here = await local.child(row.parent, name)
			return here !== null && here.id !== row.id
		}
		let name = `${row.name} (conflict ${replica})`
		for (let n = 2; await taken(name); n++) name = `${row.name} (conflict ${replica} ${n})`
		handed.add(row.parent + SEP + name)
		return name
	}
	const living = async (id: NodeId, seen = new Set<NodeId>()): Promise<NodeId> => {
		if (id === ROOT || seen.has(id)) return id
		const already = revived.get(id)
		if (already !== undefined) return already
		const buried = await remote.get(id)
		if (!buried?.deleted) return id
		await deleted?.(buried)
		const mine = await local.get(id)
		if (!mine) return id // nothing here to carry over
		seen.add(id)
		const replacement = crypto.randomUUID()
		revived.set(id, replacement)
		const parent = await living(mine.parent, seen)
		fix(mine, { ...mine, id: replacement, parent, version: mint() })
		return replacement
	}

	for (const row of rows) {
		if (row.deleted) continue // a tombstone the peer refused has nothing to save
		const theirs = await remote.get(row.id)
		if (theirs?.deleted) {
			await living(row.id)
			fix(row, theirs)
			continue
		}
		if ((await remote.get(row.parent))?.deleted) {
			fix(row, { ...row, parent: await living(row.parent), version: mint() })
			continue
		}
		const holder = await remote.child(row.parent, row.name)
		const lost = holder ? holder.id !== row.id : keeps.get(row.parent + SEP + row.name) !== row.id
		if (lost) fix(row, { ...row, name: await free(row), version: mint() })
	}
	if (fixes.length === 0) return false
	await receipt?.(fixes.filter((row) => rows.some((source) => source.id === row.id) && row.deleted))
	await local.commit(fixes, guards)
	return true
}
