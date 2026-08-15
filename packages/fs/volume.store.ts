/**
 * The POSIX view over a `Store` — read side. Design table A maps every
 * operation to seam calls, and this is that table as code: resolution is a
 * `child` per segment, `stat` is a row, `readdir` is a paged `children`,
 * `readFile` is a row plus one `blobs.get`.
 *
 * There is no cache here. The old volume cached dirents and meta because a
 * segment cost it a `getDirent` and then a `getMeta`; here a segment IS one
 * `child`, and the row it hands back is already the stat. A cache would buy
 * back nothing per segment and owe invalidation on every write.
 *
 * T6 adds the write side and T18 renames this to `volume`.
 */

import { type Cursor, type Node, type NodeId, ROOT, type Store } from './store'
import { type Dirent, FileType, type Stat } from './types'
import type { Volume } from './volume'

/** Hops, not depth: what bounds a symlink cycle. Same limit as Linux. */
const MAX_SYMLINK_HOPS = 40

const TYPE: Record<Node['type'], FileType> = {
	file: FileType.Regular,
	dir: FileType.Directory,
	symlink: FileType.Symlink,
	// A junction stands where a directory would, so that is what it stats as.
	// T15 is what makes resolution continue through it into the bound store.
	mount: FileType.Directory
}

/** The row IS the stat. Nothing here is derived, and nothing touches content. */
const statOf = (node: Node): Stat => ({
	ino: node.id,
	type: TYPE[node.type],
	size: node.size,
	mode: node.mode,
	mtimeNs: node.mtimeNs,
	// The model has no ctime (design #2, deliberate omissions): report mtime.
	ctimeNs: node.mtimeNs,
	contentHash: node.content
})

/** T6 and T7. Declared so this is a whole `Volume` — `chroot` wraps one, not a half. */
const later = async (): Promise<never> => {
	throw new Error('ENOSYS: not implemented yet')
}

export function storeVolume(store: Store): Volume {
	/**
	 * Walk from the root, one `child` per segment. `followLast` decides whether a
	 * final symlink is followed (`stat` vs `lstat`).
	 *
	 * `node` is where the walk stands and `null` is the root — the one row whose
	 * id is a constant, so a path that never lands on it costs no `get` on the
	 * hottest read in the system. `up` holds the ancestors, so `..` is a pop, and
	 * popping past the top leaves the root, which is what `/..` means.
	 */
	async function resolve(path: string, followLast: boolean): Promise<Node> {
		const queue = path.split('/').filter((s) => s !== '')
		const up: (Node | null)[] = []
		let node: Node | null = null
		let hops = 0

		for (let i = 0; i < queue.length; i++) {
			const name = queue[i]
			if (name === undefined || name === '.') continue
			if (name === '..') {
				node = up.pop() ?? null
				continue
			}

			const found = await store.child(node?.id ?? ROOT, name)
			if (found === null) throw new Error(`ENOENT: ${path}`)

			const isLast = i === queue.length - 1
			if (found.type === 'symlink' && (!isLast || followLast)) {
				if (++hops > MAX_SYMLINK_HOPS) throw new Error('ELOOP: too many levels of symbolic links')
				if (!found.link) throw new Error('EINVAL: symlink has no target')
				if (found.link.startsWith('/')) {
					up.length = 0
					node = null
				}
				// Splice the target in where the link was, so the rest of the path
				// carries on behind it and a target of its own gets the same treatment.
				queue.splice(i, 1, ...found.link.split('/').filter((s) => s !== ''))
				i--
				continue
			}

			up.push(node)
			node = found
		}

		if (node) return node
		const root = await store.get(ROOT)
		if (!root) throw new Error(`ENOENT: ${path}`) // rule 6: unreachable on a live store
		return root
	}

	/** One directory listing, page after page — the seam hands back a cursor until it is done. */
	async function* childrenOf(parent: NodeId): AsyncGenerator<Node> {
		let cursor: Cursor | undefined
		do {
			const page = await store.children(parent, cursor)
			yield* page.nodes
			cursor = page.next
		} while (cursor !== undefined)
	}

	return {
		async stat(path) {
			return statOf(await resolve(path, true))
		},

		async lstat(path) {
			return statOf(await resolve(path, false))
		},

		async exists(path) {
			try {
				await resolve(path, false)
				return true
			} catch {
				return false
			}
		},

		async getXattr(path, name) {
			return (await resolve(path, true)).xattrs?.[name] ?? null
		},

		async listXattr(path) {
			return Object.keys((await resolve(path, true)).xattrs ?? {})
		},

		async readFile(path) {
			const node = await resolve(path, true)
			if (node.type === 'dir') throw new Error(`EISDIR: ${path}`)
			if (node.content === undefined) return new Uint8Array()
			const data = await store.blobs.get(node.content)
			// A row may name content this replica does not hold — a lazy stub, not
			// an empty file. T9 fetches it; saying so is the only honest answer.
			if (data === null) throw new Error(`ENOENT: content ${node.content} of ${path}`)
			return data
		},

		async readdir(path) {
			const node = await resolve(path, true)
			if (node.type !== 'dir') throw new Error(`ENOTDIR: ${path}`)
			const entries: Dirent[] = []
			for await (const child of childrenOf(node.id))
				entries.push({ ino: child.id, name: child.name, type: TYPE[child.type] })
			return entries
		},

		async readlink(path) {
			const node = await resolve(path, false)
			if (node.type !== 'symlink') throw new Error(`EINVAL: ${path} is not a symlink`)
			if (!node.link) throw new Error('EINVAL: symlink has no target')
			return node.link
		},

		async scan(path, visitor) {
			const node = await resolve(path, true)
			await visitor(path, statOf(node))
			if (node.type !== 'dir') return

			// Rule 9: a replica may transiently hold detached or cyclic rows, so the
			// walk bounds itself instead of trusting what it is walking to be a tree.
			const seen = new Set<NodeId>([node.id])
			async function walk(dir: NodeId, dirPath: string): Promise<void> {
				for await (const child of childrenOf(dir)) {
					if (seen.has(child.id)) continue
					seen.add(child.id)
					const childPath = dirPath === '/' ? `/${child.name}` : `${dirPath}/${child.name}`
					await visitor(childPath, statOf(child))
					if (child.type === 'dir') await walk(child.id, childPath)
				}
			}
			await walk(node.id, path)
		},

		setXattr: later,
		removeXattr: later,
		writeFile: later,
		appendFile: later,
		mkdir: later,
		rm: later,
		rename: later,
		cp: later,
		symlink: later,
		chmod: later,
		utimes: later,
		watch: later
	}
}
