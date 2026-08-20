/**
 * The oracle. Random work against `fsStore`, checked against something that knows the
 * answer — thousands of cases, off a seed, in the time one temp-dir case takes. Every
 * failure prints its seed; re-run with `--seed` to replay it exactly.
 *
 * Two properties, the two halves of what this backend claims:
 *
 * - **What the tree holds is what the rows say.** After any sequence of changes made
 *   OUTSIDE the store, the paths it resolves and the bytes it reads must be exactly what
 *   a walk of the disk finds. The hand-written cases each prove one instance of this.
 * - **A commit means the same thing here as anywhere.** The same batches against
 *   `memStore` and against this must leave the same tree. Where they are ALLOWED to
 *   differ is stated below and nowhere else.
 *
 * What it deliberately does NOT generate: directory modes that shut the store out. The
 * expected answer is a walk of the same disk, and a walk that cannot read where the
 * store let itself in has no answer to compare with. That family has its own cases, over
 * a real filesystem, in `fs.test.ts`.
 */

import fc from 'fast-check'
import { expect, test } from 'vitest'
import { AT_ROOT, type Spot, spot, up } from './disk'
import { memDisk } from './disk.mem'
import { fsStore } from './fs'
import { memStore } from './mem'
import { type Cursor, type Node, ROOT, type Store, sha256Hex } from './store'

/**
 * How many cases per property. Cheap enough that the default is a real search — sixty
 * thousand cases run in about twelve seconds — and `JFS_RUNS` turns it up for a hunt.
 */
const RUNS = Number(process.env.JFS_RUNS ?? 300)

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A small pool, so names collide — which is where everything interesting is. */
const NAMES = ['a', 'b', 'c']
const BODIES = ['one', 'two', 'three', '']

type Op =
	| { at: string[]; write: string }
	| { at: string[]; mkdir: true }
	| { at: string[]; rm: true }
	| { from: string[]; to: string[] }

const path = fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 3 })

const op: fc.Arbitrary<Op> = fc.oneof(
	fc.record({ at: path, write: fc.constantFrom(...BODIES) }),
	fc.record({ at: path, mkdir: fc.constant(true as const) }),
	fc.record({ at: path, rm: fc.constant(true as const) }),
	fc.record({ from: path, to: path })
)

/** Drain the feed. A store that is caught up says so with an empty page. */
async function quiet(store: Store): Promise<Node[]> {
	const rows: Node[] = []
	let cursor: Cursor | undefined
	for (let turn = 0; turn < 200; turn++) {
		const page = await store.since(cursor)
		cursor = page.next
		if (page.nodes.length === 0) return rows
		rows.push(...page.nodes)
	}
	throw new Error('since never caught up')
}

/** Every path the STORE resolves, and what it says is there. */
async function asRows(store: Store): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	const walk = async (id: string, at: string): Promise<void> => {
		for (let cursor: Cursor | undefined; ; ) {
			const page = await store.children(id, cursor)
			for (const row of page.nodes) {
				const here = at === '' ? row.name : `${at}/${row.name}`
				if (row.type === 'dir') {
					out.set(here, 'dir')
					await walk(row.id, here)
				} else if (row.type === 'symlink') out.set(here, `link:${row.link}`)
				else {
					const data = row.content === undefined ? null : await store.blobs.get(row.content)
					out.set(here, `file:${data === null ? '' : dec.decode(data)}`)
				}
			}
			if (page.next === undefined) return
			cursor = page.next
		}
	}
	await walk(ROOT, '')
	return out
}

/** Every path the DISK holds, and what is there. The store's own corner skipped. */
async function asDisk(disk: ReturnType<typeof memDisk>): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	const walk = async (at: string): Promise<void> => {
		const here = spot(at)
		if (here === null) return
		for (const name of (await disk.list(here)) ?? []) {
			if (at === '' && name === '.jfs') continue
			const here = at === '' ? name : `${at}/${name}`
			const down = spot(here)
			if (down === null) continue
			const s = await disk.stat(down)
			if (s === null) continue
			if (s.isDirectory()) {
				out.set(here, 'dir')
				await walk(here)
			} else if (s.isSymbolicLink()) out.set(here, `link:${await disk.target(down)}`)
			else {
				const data = await disk.bytes(down)
				out.set(here, `file:${data === null ? '' : dec.decode(data)}`)
			}
		}
	}
	await walk('')
	return out
}

/**
 * One change made outside the store, the way a local tool would make it — and like a
 * local tool, it simply fails where the filesystem says no. A generator that asks for a
 * file inside a file gets what `echo > b/a` gets: nothing happens.
 */
async function apply(disk: ReturnType<typeof memDisk>, what: Op): Promise<void> {
	await outside(disk, what).catch(() => {})
}

async function outside(disk: ReturnType<typeof memDisk>, what: Op): Promise<void> {
	const spotOf = (names: string[]): Spot | null => spot(names.join('/'))
	if ('from' in what) {
		const from = spotOf(what.from)
		const to = spotOf(what.to)
		if (from === null || to === null || from === to) return
		const s = await disk.stat(from)
		if (s === null) return
		const into = up(to)
		if (into !== AT_ROOT) await disk.dir(into)
		// A move a local tool makes: no identity check, because a local tool has none.
		await disk.move({ path: from, ino: String(s.ino), state: '' }, to)
		return
	}
	const at = spotOf(what.at)
	if (at === null) return
	if ('mkdir' in what) {
		await disk.dir(at)
		return
	}
	if ('rm' in what) {
		await disk.clear(at)
		return
	}
	const into = up(at)
	if (into !== AT_ROOT) await disk.dir(into)
	// Only over a file, so the generator cannot ask for a file on top of a directory
	// and get an answer neither side agrees about.
	const s = await disk.stat(at)
	if (s?.isDirectory()) return
	await disk.write(at, enc.encode(what.write), undefined, 'unseen')
}

/**
 * Which row holds which file, by inode. What is asked of it is ONE FILE, ONE ROW: no two
 * live rows ever name the same inode. That is what `owner` is for, and a scan that asked
 * the tree instead would adopt one file twice while leaving the shape of the tree — and
 * so a shape comparison — untouched.
 *
 * What is NOT asked of it is that an id survive a rename made outside. `readdir` and
 * `lstat` are all this backend gets, so a name that vanished is a tombstone and a name
 * that appeared is a new node, even where the same inode is under both. What can still
 * be asked, and is below, is that a pass which found NOTHING new rebinds nothing: the
 * store must be quiet when the disk is.
 */
async function asBound(
	store: Store,
	disk: ReturnType<typeof memDisk>
): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	const walk = async (id: string, at: string): Promise<void> => {
		for (let cursor: Cursor | undefined; ; ) {
			const page = await store.children(id, cursor)
			for (const row of page.nodes) {
				const here = at === '' ? row.name : `${at}/${row.name}`
				const down = spot(here)
				const s = down === null ? null : await disk.stat(down)
				if (s !== null) out.set(String(s.ino), row.id)
				if (row.type === 'dir') await walk(row.id, here)
			}
			if (page.next === undefined) return
			cursor = page.next
		}
	}
	await walk(ROOT, '')
	return out
}

function oneFileOneRow(now: Map<string, string>): void {
	expect(new Set(now.values()).size).toBe(now.size)
}

test('what the tree holds is what the rows say', async () => {
	await fc.assert(
		fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
			const disk = memDisk()
			const store = fsStore('mem', { disk: disk })
			await quiet(store) // open, and take the tree as it is

			for (const what of ops) {
				await apply(disk, what)
				await quiet(store)
				oneFileOneRow(await asBound(store, disk))
			}
			// Twice, because a pass that adopts a row it just found makes changes of its
			// own — and the SECOND pass has to have nothing left to say.
			const settled = await asBound(store, disk)
			await quiet(store)
			// Quiet when the disk is: nothing moved, so nothing may be rebound.
			expect(Object.fromEntries(await asBound(store, disk))).toEqual(Object.fromEntries(settled))

			expect(Object.fromEntries(await asRows(store))).toEqual(
				Object.fromEntries(await asDisk(disk))
			)
			await store.close?.()
		}),
		{ numRuns: RUNS }
	)
}, 120_000)

test('a reopen sees exactly what the store that wrote it saw', async () => {
	// The sidecar's whole job. A second store over the same tree reads the index and
	// must land on the same answer — no id rebound, no lineage lost, nothing adopted
	// twice. A crash is this without the clean shutdown, which is why it is worth
	// asking after arbitrary work rather than after a fixed script.
	await fc.assert(
		fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
			const disk = memDisk()
			const first = fsStore('mem', { disk: disk })
			await quiet(first)
			for (const what of ops) {
				await apply(disk, what)
				await quiet(first)
			}
			await quiet(first)
			const before = await asRows(first)
			const ids = new Map([...(await quiet(first))].map((row) => [row.id, row.name]))
			await first.close?.()

			const again = fsStore('mem', { disk: disk })
			await quiet(again)
			expect(Object.fromEntries(await asRows(again))).toEqual(Object.fromEntries(before))
			// And the ids are the ones the sidecar held, not fresh ones over the same files.
			for (const row of await quiet(again))
				if (!row.deleted && ids.has(row.id)) expect(row.name).toBe(ids.get(row.id))
			await again.close?.()
		}),
		{ numRuns: RUNS }
	)
}, 120_000)

test('a commit leaves the same tree here as it leaves in memory', async () => {
	// The seam's own claim, checked against the store that defines it. Versions and
	// stamps are allowed to differ — this backend mints its own when it observes what
	// it placed, which is the whole reason `restated` exists — so what is compared is
	// the tree: which names resolve, to what kind, holding which bytes.
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.record({
					name: fc.constantFrom(...NAMES),
					body: fc.constantFrom(...BODIES),
					dir: fc.boolean()
				}),
				{ minLength: 1, maxLength: 8 }
			),
			async (writes) => {
				const disk = memDisk()
				const here = fsStore('mem', { disk: disk })
				const there = memStore()
				await quiet(here)

				for (const { name, body, dir } of writes) {
					const data = enc.encode(body)
					const hash = await sha256Hex(data)
					const held = await here.child(ROOT, name)
					const row: Node = {
						id: held?.id ?? crypto.randomUUID(),
						parent: ROOT,
						name,
						type: dir ? 'dir' : 'file',
						mode: dir ? 0o040755 : 0o100644,
						mtimeNs: 0n,
						size: BigInt(data.length),
						version: crypto.randomUUID()
					}
					if (!dir) {
						row.content = hash
						await here.blobs.put(hash, data)
						await there.blobs.put(hash, data)
					}
					// A re-typed row keeps its id in both, so the two stay comparable.
					await here.commit([row])
					await there.commit([{ ...row, id: held?.id ?? row.id }])
					await quiet(here)
				}
				await quiet(here)

				expect(Object.fromEntries(await asRows(here))).toEqual(
					Object.fromEntries(await asRows(there))
				)
				await here.close?.()
			}
		),
		{ numRuns: RUNS }
	)
}, 120_000)

test('a commit and a local tool, taking turns on the same names', async () => {
	// Where `settle` earns its keep: a commit looks at the disk before it judges a guard,
	// because the tree it is about to write through may not be the one the index
	// remembers. The claim is not that the store wins, or that the tool does — it is that
	// afterwards the rows and the tree say the SAME thing, whoever got there last.
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.oneof(
					fc.record({ outside: op }),
					fc.record({
						commit: fc.record({
							name: fc.constantFrom(...NAMES),
							body: fc.constantFrom(...BODIES),
							dir: fc.boolean(),
							gone: fc.boolean(),
							// A SECOND live row for a name another row already holds. The
							// contract allows it (rule 1) and the disk has one dirent per
							// name, so the store has to pick — and everything under the one
							// that lost is as unreachable as it is.
							rival: fc.boolean()
						})
					})
				),
				{ minLength: 1, maxLength: 12 }
			),
			async (turns) => {
				const disk = memDisk()
				const store = fsStore('mem', { disk: disk })
				await quiet(store)

				for (const turn of turns) {
					if ('outside' in turn) {
						await apply(disk, turn.outside)
						await quiet(store)
						continue
					}
					const { name, body, dir, gone, rival } = turn.commit
					const held = await store.child(ROOT, name)
					if (gone) {
						// A tombstone for a name that may have been taken by the tool since.
						if (held) await store.commit([{ ...held, deleted: true, version: crypto.randomUUID() }])
						await quiet(store)
						continue
					}
					const data = enc.encode(body)
					const hash = await sha256Hex(data)
					await store.blobs.put(hash, data)
					const row: Node = {
						id: rival || held === null ? crypto.randomUUID() : held.id,
						parent: ROOT,
						name,
						type: dir ? 'dir' : 'file',
						mode: dir ? 0o040755 : 0o100644,
						mtimeNs: 0n,
						size: BigInt(data.length),
						version: crypto.randomUUID()
					}
					if (!dir) row.content = hash
					await store.commit([row])
					await quiet(store)
				}
				await quiet(store)

				oneFileOneRow(await asBound(store, disk))
				expect(Object.fromEntries(await asRows(store))).toEqual(
					Object.fromEntries(await asDisk(disk))
				)
				await store.close?.()
			}
		),
		{ numRuns: RUNS }
	)
}, 120_000)
