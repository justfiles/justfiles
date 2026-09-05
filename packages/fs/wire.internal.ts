import type { SyncConflict } from './conflict.internal'
import type { Guard, Node, Page } from './store'

export type WireNode = Omit<Node, 'mtimeNs' | 'size' | 'xattrs'> & {
	mtimeNs: string
	size: string
	xattrs?: Record<string, string>
}

export const encodeNode = ({ mtimeNs, size, xattrs, ...rest }: Node): WireNode => {
	const wire: WireNode = { ...rest, mtimeNs: String(mtimeNs), size: String(size) }
	if (xattrs !== undefined)
		wire.xattrs = Object.fromEntries(
			Object.entries(xattrs).map(([name, value]) => [name, base64(value)])
		)
	return wire
}

export const decodeNode = (value: unknown): Node => {
	const row = fields(value, 'a node')
	const node: Node = {
		id: text(row.id, 'id'),
		parent: text(row.parent, 'parent'),
		name: text(row.name, 'name'),
		type: kind(row.type),
		mode: whole(row.mode, 'mode'),
		mtimeNs: digits(row.mtimeNs, 'mtimeNs', SIGNED),
		size: digits(row.size, 'size', UNSIGNED),
		version: text(row.version, 'version')
	}
	if (row.xattrs !== undefined)
		node.xattrs = Object.fromEntries(
			Object.entries(fields(row.xattrs, 'xattrs')).map(([name, value]) => [
				name,
				unbase64(text(value, `xattr ${name}`))
			])
		)
	if (row.content !== undefined) node.content = text(row.content, 'content')
	if (row.link !== undefined) node.link = text(row.link, 'link')
	if (row.deleted !== undefined) node.deleted = row.deleted === true ? true : bad('deleted')
	return node
}

export const decodeCommit = (value: unknown): { writes: Node[]; guards?: Guard[] } => {
	const body = fields(value, 'a commit')
	const writes = list(body.writes, 'writes').map(decodeNode)
	if (body.guards === undefined) return { writes }
	return { writes, guards: list(body.guards, 'guards').map(decodeGuard) }
}

export const decodePage = (value: unknown): Page => {
	const page = fields(value, 'a page')
	const nodes = list(page.nodes, 'nodes').map(decodeNode)
	return page.next === undefined ? { nodes } : { nodes, next: text(page.next, 'next') }
}

const decodeGuard = (value: unknown): Guard => {
	const guard = fields(value, 'a guard')
	if (guard.free !== undefined) {
		const free = fields(guard.free, 'a free guard')
		return {
			free: { parent: text(free.parent, 'free.parent'), name: text(free.name, 'free.name') }
		}
	}
	const version = fields(guard.version, 'a version guard')
	return {
		version: {
			id: text(version.id, 'version.id'),
			is: version.is === null ? null : text(version.is, 'version.is')
		}
	}
}

const bad = (what: string): never => {
	throw new TypeError(`malformed ${what} on the wire`)
}

const fields = (value: unknown, what: string): Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: bad(what)

const list = (value: unknown, what: string): unknown[] => (Array.isArray(value) ? value : bad(what))

const text = (value: unknown, what: string): string =>
	typeof value === 'string' ? value : bad(what)

const whole = (value: unknown, what: string): number =>
	typeof value === 'number' && Number.isInteger(value) ? value : bad(what)

const digits = (value: unknown, what: string, pattern: RegExp): bigint =>
	typeof value === 'string' && pattern.test(value) ? BigInt(value) : bad(what)

const SIGNED = /^-?\d+$/
const UNSIGNED = /^\d+$/

const kind = (value: unknown): Node['type'] =>
	value === 'file' || value === 'dir' || value === 'symlink' || value === 'mount'
		? value
		: bad('type')

const base64 = (data: Uint8Array): string => {
	let binary = ''
	for (const byte of data) binary += String.fromCharCode(byte)
	return btoa(binary)
}

const unbase64 = (value: string): Uint8Array =>
	Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

export const encodeConflict = (conflict: SyncConflict) => ({
	...conflict,
	authority: conflict.authority.map(({ id, row }) => ({
		id,
		row: row === null ? null : encodeNode(row)
	}))
})

export const decodeConflict = (value: unknown): SyncConflict => {
	const conflict = fields(value, 'conflict')
	const trigger = fields(conflict.trigger, 'trigger')
	const seen = new Set<string>()
	return {
		kind: text(conflict.kind, 'kind'),
		trigger: {
			id: text(trigger.id, 'id'),
			parent: text(trigger.parent, 'parent'),
			version: text(trigger.version, 'version')
		},
		authority: list(conflict.authority, 'authority').map((value) => {
			const observation = fields(value, 'observation')
			const id = text(observation.id, 'id')
			const row = observation.row === null ? null : decodeNode(observation.row)
			if (seen.has(id) || (row !== null && row.id !== id)) bad('observation')
			seen.add(id)
			return { id, row }
		})
	}
}

export const decodeRefusal = (value: unknown): Guard => {
	const guard = fields(value, 'refusal')
	if (guard.free === undefined && guard.version === undefined) bad('refusal')
	return decodeGuard(guard)
}
