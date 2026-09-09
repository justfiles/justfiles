import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { authority } from './authority'
import { type SyncConflict, SyncConflictError } from './conflict.internal'
import { type CursorSlot, sync } from './engine'
import { idbStore } from './idb'
import { memStore } from './mem'
import { BootstrapRequiredError } from './peer'
import { decide, fingerprint, recover } from './recovery'
import { decodeRows, RECOVERED, recoveryState, scan } from './recovery.state.internal'
import { type Cursor, GuardError, type Node, ROOT, type Store, sha256Hex } from './store'
import { synced } from './synced'
import { volume } from './volume'
import { decodeConflict, encodeConflict } from './wire.internal'

const enc = new TextEncoder()
const dec = new TextDecoder()
const row = (id: string, over: Partial<Node> = {}): Node => ({
	id,
	name: id,
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	size: 0n,
	mtimeNs: 1234567890123456789n,
	version: `b:${id}`,
	...over
})
const slot = (): CursorSlot => {
	let cursor: Cursor | undefined
	return {
		load: async () => cursor,
		save: async (value) => {
			cursor = value
		}
	}
}
const options = (recovery?: Store) => ({
	replica: 'b',
	pull: slot(),
	push: slot(),
	retries: 0,
	backoffMs: 0,
	recovery
})
const facts = (kind: string, source = row('x'), observations: Node[] = []): SyncConflict => ({
	kind,
	trigger: { id: source.id, parent: source.parent, version: source.version },
	authority: observations.map((row) => ({ id: row.id, row }))
})
const refusal = async (remote: Store, rows: Node[]): Promise<SyncConflict> => {
	try {
		await remote.commit(rows)
	} catch (error) {
		if (error instanceof SyncConflictError) return error.conflict
		throw error
	}
	throw new Error('expected refusal')
}
const manifests = async (store: Store) => {
	const values = await Promise.all(
		(await scan(store))
			.filter((row) => row.parent === 'sync-recovery-state' && row.content && !row.deleted)
			.map(async (row) =>
				JSON.parse(dec.decode((await store.blobs.get(row.content as string)) ?? undefined))
			)
	)
	return values.filter((value) => value.sources !== undefined)
}
const fileCopies = async (store: Store) =>
	(await scan(store)).filter(
		(row) => row.parent !== 'sync-recovery-state' && row.type === 'file' && !row.deleted
	)

it.each([
	['deleted-id', 'revive'],
	['deleted-parent', 'ancestors'],
	['duplicate-name', 'rename'],
	['taken-name', 'rename'],
	['invalid-root', 'root'],
	['invalid-parent', 'branch'],
	['has-children', 'replacement'],
	['parent-cycle', 'cycle'],
	['structural', 'graph'],
	['new-policy', 'unresolved']
])('decides %s as %s without changing facts', (kind, decision) => {
	const conflict = facts(kind)
	const before = structuredClone(conflict)
	expect(decide(conflict)).toBe(decision)
	expect(conflict).toEqual(before)
})

it('canonically reports violations and fingerprints independent of page order', async () => {
	const remote = authority(memStore())
	const deleted = row('a', { deleted: true })
	await remote.commit([deleted, row('parent')])
	const a = row('a', { parent: 'parent', version: 'b:new' })
	const b = row('z', { parent: 'parent' })
	const first = await refusal(remote, [b, a])
	const second = await refusal(remote, [a, b])
	expect(first).toEqual(second)
	expect(first.kind).toBe('deleted-id')
	expect(decide(first)).toBe('revive')
	expect(fingerprint(first, [a, b])).toBe(
		fingerprint({ ...second, authority: second.authority.toReversed() }, [b, a])
	)
})

it('round-trips structured refusals with bigint and binary xattrs; omissions stay unknown', () => {
	const source = row('x', {
		size: 9007199254740993n,
		xattrs: { 'user.raw': new Uint8Array([0, 255, 128]) }
	})
	const conflict = facts('future-kind', source, [source])
	conflict.authority.push({ id: 'absent', row: null })
	expect(decodeConflict(JSON.parse(JSON.stringify(encodeConflict(conflict))))).toEqual(conflict)
	expect(() => decodeConflict({ kind: 'future-kind' })).toThrow()
	expect(() => decodeConflict({ ...encodeConflict(conflict), authority: [{ id: 'x' }] })).toThrow()
	expect(() =>
		decodeConflict({
			...encodeConflict(conflict),
			authority: [{ id: 'wrong', row: encodeConflict(conflict).authority[0]?.row }]
		})
	).toThrow()
})

for (const [name, fresh] of [
	['memory', memStore],
	['IndexedDB', () => idbStore(`recovery-${crypto.randomUUID()}`)]
] as const)
	describe(name, () => {
		it('preserves exact source fields, xattrs, lazy bytes and descendants outside the rejected page', async () => {
			const local = fresh(),
				raw = fresh(),
				recovery = fresh()
			const remote = authority(raw)
			const bytes = enc.encode('private displaced content')
			const hash = await sha256Hex(bytes)
			await raw.blobs.put(hash, bytes)
			await remote.commit([row('mount', { type: 'mount', version: 'a:mount' })])
			const branch = row('branch', { type: 'dir', parent: 'mount' })
			const child = row('child', {
				parent: 'branch',
				size: BigInt(bytes.length),
				content: hash,
				xattrs: { 'user.a': enc.encode('unchanged') }
			})
			await local.commit([branch, child])
			const get = vi.spyOn(remote, 'get')
			const state = await recoveryState(recovery, 'b', 'hub')
			expect(
				await recover({
					local,
					remote,
					recovery,
					state,
					replica: 'b',
					rows: [branch],
					conflict: await refusal(remote, [branch])
				})
			).toEqual({ status: 'applied' })
			expect(get).toHaveBeenCalledWith('child')
			const copy = (await fileCopies(recovery))[0]
			expect(copy).toMatchObject({
				...child,
				id: expect.any(String),
				parent: expect.any(String),
				version: expect.any(String)
			})
			expect(copy?.id).not.toBe(child.id)
			expect(await recovery.blobs.get(hash)).toEqual(bytes)
			expect(decodeRows((await manifests(recovery))[0].sources)).toEqual([branch, child])
			for (const source of [branch, child]) {
				expect(await local.get(source.id)).toEqual(await remote.get(source.id))
				expect(await remote.get(source.id)).toMatchObject({ deleted: true })
			}
			expect((await scan(raw)).some((row) => row.id === RECOVERED)).toBe(false)
			await Promise.all([local.close?.(), raw.close?.(), recovery.close?.()])
		})

		it('restores an invalid root without displacing its children or replacing the shared store', async () => {
			const local = fresh(),
				raw = fresh(),
				recovery = fresh(),
				remote = authority(raw)
			const child = row('child')
			const broken = row(ROOT, { type: 'file', name: '', version: 'b:broken' })
			await local.commit([broken, child])
			await sync(local, remote, options(recovery))
			expect(await local.get(ROOT)).toEqual(await remote.get(ROOT))
			expect(await local.get('child')).toEqual(child)
			const saved = await manifests(recovery)
			expect(saved).toHaveLength(1)
			expect(decodeRows(saved[0].sources)).toEqual([broken])
			await Promise.all([local.close?.(), raw.close?.(), recovery.close?.()])
		})
	})

it('turns cycles, duplicates, detached edges and tombstones into a valid private forest for unknown conflicts', async () => {
	const local = memStore(),
		remote = authority(memStore()),
		recovery = memStore()
	const sources = [
		row('a', { parent: 'b', type: 'dir' }),
		row('b', { parent: 'a', type: 'dir' }),
		row('c', { parent: 'a', name: 'same' }),
		row('d', { parent: 'a', name: 'same' }),
		row('e', { parent: 'missing' }),
		row('gone', { deleted: true })
	]
	await local.commit(sources)
	const state = await recoveryState(recovery, 'b', 'hub')
	expect(
		await recover({
			local,
			remote,
			recovery,
			state,
			replica: 'b',
			rows: sources,
			conflict: facts('new-kind', sources[0])
		})
	).toEqual({ status: 'applied' })
	const manifest = (await manifests(recovery))[0]
	expect(manifest.decision).toBe('unresolved')
	expect(decodeRows(manifest.sources)).toEqual(sources)
	const copies = decodeRows(manifest.copies)
	const checker = authority(memStore())
	await checker.commit([(await recovery.get(RECOVERED)) as Node, ...copies])
	const a = copies.find((row) => row.name === 'a')
	expect(a?.parent).toBe(copies[0]?.id)
	expect(copies.map((row) => row.name)).toEqual(expect.arrayContaining(['same', 'same (2)']))
	expect(copies.some((row) => row.name === 'gone')).toBe(false)
})

async function branchCase() {
	const local = memStore(),
		raw = memStore(),
		recovery = memStore(),
		remote = authority(raw)
	await remote.commit([row('mount', { type: 'mount', version: 'a:1' })])
	const source = row('x', { parent: 'mount', type: 'dir' })
	await local.commit([source])
	const conflict = await refusal(remote, [source])
	const state = await recoveryState(recovery, 'b', 'hub')
	return { local, raw, remote, recovery, state, source, conflict, rows: [source], replica: 'b' }
}

it.each([
	'missing bytes',
	'quota',
	'verification',
	'scan limit',
	'unreadable state'
])('%s stops before shared settlement', async (failure) => {
	const input = await branchCase()
	const before = await scan(input.local)
	let candidate = input
	if (failure === 'missing bytes') {
		const child = row('child', { parent: 'x', size: 1n, content: 'missing' })
		await input.local.commit([child])
		before.push(child)
	}
	if (failure === 'quota')
		vi.spyOn(input.recovery.blobs, 'put').mockRejectedValue(new Error('quota'))
	if (failure === 'verification')
		vi.spyOn(input.recovery, 'commit').mockImplementation(async () => {})
	if (failure === 'unreadable state')
		vi.spyOn(input.recovery, 'get').mockRejectedValue(new Error('unavailable'))
	if (failure === 'scan limit') candidate = { ...input, scanLimit: 1 } as typeof input
	const commit = vi.spyOn(input.remote, 'commit')
	expect((await recover(candidate)).status).toBe('failed')
	expect(commit).not.toHaveBeenCalled()
	expect(await scan(input.local)).toEqual(before)
})

it('fails on a foreign fixed root id and numbers a user-owned name', async () => {
	const input = await branchCase()
	await input.recovery.commit([row(RECOVERED, { type: 'dir' })])
	expect((await recover(input)).status).toBe('failed')
	const other = await branchCase()
	await other.recovery.commit([row('user-root', { type: 'dir', name: 'Recovered items' })])
	expect(await recover(other)).toEqual({ status: 'applied' })
	expect(await other.recovery.get(RECOVERED)).toMatchObject({ name: 'Recovered items (2)' })
})

it('concurrent private root creation converges on one owned root', async () => {
	const recovery = memStore()
	const [a, b] = await Promise.all([
		recoveryState(recovery, 'b', 'hub'),
		recoveryState(recovery, 'b', 'hub')
	])
	const roots = await Promise.all([a.root(), b.root()])
	expect(roots[0]).toEqual(roots[1])
	expect((await scan(recovery)).filter((row) => row.id === RECOVERED)).toHaveLength(1)
})

it('an authority id appearing before settlement loses the null guard and remains intact', async () => {
	const input = await branchCase()
	const arrival = row('x', { type: 'dir', version: 'a:arrival' })
	const commit = input.remote.commit
	input.remote.commit = async (rows, guards) => {
		await commit([arrival])
		await commit(rows, guards)
	}
	expect(await recover(input)).toEqual({ status: 'raced' })
	expect(await input.remote.get('x')).toEqual(arrival)
	expect(await input.local.get('x')).toEqual(input.source)
})

it.each([
	'existing',
	'racing'
])('%s detached authority children block absent-parent settlement atomically', async (when) => {
	const local = memStore(),
		remote = authority(memStore()),
		recovery = memStore()
	const source = row('D')
	const child = row('C', { parent: 'D', version: 'a:child' })
	await local.commit([source])
	const state = await recoveryState(recovery, 'b', 'hub')
	if (when === 'existing') await remote.commit([child])
	else {
		const commit = remote.commit
		remote.commit = async (rows, guards) => {
			await commit([child])
			await commit(rows, guards)
		}
	}
	const result = await recover({
		local,
		remote,
		recovery,
		state,
		replica: 'b',
		rows: [source],
		conflict: facts('has-children', source, [child])
	})
	expect(result).toMatchObject({ status: 'failed', error: { message: 'settlement-has-children' } })
	expect(await remote.get('D')).toBeNull()
	expect(await remote.get('C')).toEqual(child)
	expect(await local.get('D')).toEqual(source)
	expect(await fileCopies(recovery)).toHaveLength(1)
})

it('ordinary recursive delete can still arrive ahead of its children', async () => {
	const remote = authority(memStore())
	const parent = row('D', { type: 'dir' })
	await remote.commit([parent, row('C', { parent: 'D' })])
	await expect(
		remote.commit([{ ...parent, deleted: true, version: 'b:deleted' }])
	).resolves.toBeUndefined()
})

it.each([
	'before receipts',
	'before adoption',
	'after adoption'
])('resumes a crash %s without reminting settlement versions', async (point) => {
	const input = await branchCase()
	const original = input.local.commit
	if (point === 'before receipts') {
		const commit = input.remote.commit
		input.remote.commit = async (rows, guards) => {
			await commit(rows, guards)
			throw new Error('crash')
		}
	} else
		input.local.commit = async (rows, guards) => {
			if (point === 'after adoption') await original(rows, guards)
			throw new Error('crash')
		}
	expect((await recover(input)).status).toBe('failed')
	const settled = await input.remote.get('x')
	expect(settled?.deleted).toBe(true)
	input.remote.commit = authority(input.raw).commit
	input.local.commit = original
	if (point === 'after adoption') {
		expect(await input.state.adopted(settled as Node)).toBe(true)
		return
	}
	const conflict = await refusal(input.remote, input.rows)
	const state = await recoveryState(input.recovery, 'b', 'hub')
	expect(await recover({ ...input, state, conflict })).toEqual({ status: 'applied' })
	expect(await input.local.get('x')).toEqual(settled)
	expect(await manifests(input.recovery)).toHaveLength(1)
})

it('recaptures changed directories and new descendants when resuming through a child refusal', async () => {
	const input = await branchCase()
	const original = input.local.commit
	input.local.commit = async () => {
		throw new Error('crash')
	}
	await recover(input)
	input.local.commit = original
	const changed = { ...input.source, version: 'b:changed' }
	const child = row('child', { parent: 'x' })
	await input.local.commit([changed, child])
	const conflict = await refusal(input.remote, [child])
	expect(conflict.kind).toBe('deleted-parent')
	expect(await recover({ ...input, rows: [child], conflict })).toEqual({ status: 'applied' })
	expect(await input.local.get('x')).toMatchObject({ deleted: true })
	expect(await input.local.get('child')).toMatchObject({ deleted: true })
	expect(await fileCopies(input.recovery)).toHaveLength(1)
	expect(
		(await manifests(input.recovery)).some((manifest) =>
			decodeRows(manifest.sources).some((row) => row.id === 'child')
		)
	).toBe(true)
})

it.each([
	'edited',
	'deleted'
])('a recovered copy %s after a crash gets a fresh attempt and is never overwritten', async (change) => {
	const input = await branchCase()
	const original = input.local.commit
	input.local.commit = async () => {
		throw new Error('crash')
	}
	await recover(input)
	input.local.commit = original
	const saved = (await manifests(input.recovery))[0]
	const copy = decodeRows(saved.copies).find((row) => row.name === 'x') as Node
	const edited = {
		...copy,
		name: 'user copy',
		version: 'user:edit',
		...(change === 'deleted' ? { deleted: true as const } : {})
	}
	await input.recovery.commit([edited])
	const conflict = await refusal(input.remote, input.rows)
	expect(await recover({ ...input, conflict })).toEqual({ status: 'applied' })
	expect(await input.recovery.get(copy.id)).toEqual(edited)
	expect(await manifests(input.recovery)).toHaveLength(2)
})

it('adoption filtering survives a concurrent authority edit, restart, cursor reset and nested push; fresh edits push', async () => {
	const local = memStore(),
		raw = memStore(),
		recovery = memStore(),
		remote = authority(raw)
	const old = row(ROOT, { type: 'dir', name: '', version: 'b:old' })
	const newest = { ...old, version: 'a:newest', mode: 0o40750 }
	await remote.commit([old])
	await local.commit([row(ROOT, { name: '', version: 'b:invalid' })])
	const put = recovery.blobs.put
	let changed = false
	recovery.blobs.put = async (hash, bytes) => {
		await put(hash, bytes)
		const text = dec.decode(bytes)
		if (!changed && text.includes('"sources"')) {
			changed = true
			await remote.commit([newest])
		}
	}
	const opts = options(recovery)
	await sync(local, remote, opts)
	expect(changed).toBe(true)
	expect(await remote.get(ROOT)).toEqual(newest)
	expect(await local.get(ROOT)).toEqual(newest)
	// Simulate a process dying after installing the observed row but before pull.
	await local.commit([old])
	await opts.push.save(undefined)
	await opts.pull.save(undefined)
	const writes = vi.spyOn(remote, 'commit')
	await sync(local, remote, opts)
	expect(writes).not.toHaveBeenCalled()
	expect(await local.get(ROOT)).toEqual(newest)
	// Introduce the adopted state after the outer push, while a pull page is in flight.
	const since = remote.since
	let nested = false
	await opts.pull.save(undefined)
	remote.since = async (cursor) => {
		const page = await since(cursor)
		if (!nested) {
			nested = true
			await local.commit([old])
		}
		return page
	}
	await sync(local, remote, opts)
	expect(writes).not.toHaveBeenCalled()
	expect(await local.get(ROOT)).toEqual(newest)
	const edit = { ...newest, version: 'b:fresh', mode: 0o40755 }
	await local.commit([edit])
	await sync(local, remote, opts)
	expect(await remote.get(ROOT)).toEqual(edit)
})

it('synced passes private storage through its lifecycle and mounts readable recovered files', async () => {
	const local = memStore(),
		raw = memStore(),
		recovery = memStore(),
		remote = authority(raw)
	const original = row(ROOT, { name: '', version: 'b:bad' })
	await local.commit([original])
	const vol = await synced({ local, remote, ...options(recovery), interval: 60_000 })
	try {
		expect(vol.status()).toBe('synced')
		expect(await local.get(ROOT)).toEqual(await remote.get(ROOT))
		const entries = await volume(recovery).readdir('/Recovered items')
		expect(entries).toHaveLength(1)
		expect(await fileCopies(recovery)).toHaveLength(1)
	} finally {
		vol.destroy()
		await vol.drain()
	}
})

it('missing private state fails before any push even when no refusal is pending', async () => {
	const local = memStore(),
		remote = authority(memStore()),
		recovery = memStore()
	await local.commit([row('pending')])
	vi.spyOn(recovery, 'get').mockRejectedValue(new Error('closed'))
	const commit = vi.spyOn(remote, 'commit')
	await expect(sync(local, remote, options(recovery))).rejects.toThrow(
		'required recovery state is unavailable'
	)
	expect(commit).not.toHaveBeenCalled()
})

it('unstructured refusals are terminal protocol errors without transport retries', async () => {
	const local = memStore(),
		remote = memStore()
	await local.commit([row('pending')])
	const commit = vi.spyOn(remote, 'commit').mockRejectedValue(new GuardError('legacy refusal'))
	await expect(sync(local, remote, { ...options(), retries: 3 })).rejects.toThrow(
		'unstructured sync refusal'
	)
	expect(commit).toHaveBeenCalledTimes(1)
})

it('repeated applied fingerprints stop before another recovery', async () => {
	const local = memStore(),
		remote = authority(memStore())
	await remote.commit([row('holder', { name: 'same', version: 'a:1' })])
	await local.commit([row('loser', { name: 'same' })])
	const install = vi.spyOn(local, 'commit').mockResolvedValue(undefined)
	const commit = vi.spyOn(remote, 'commit')
	await expect(sync(local, remote, { ...options(), retries: 3 })).rejects.toThrow(
		'repeated applied recovery conflict'
	)
	expect(install).toHaveBeenCalledTimes(1)
	expect(commit).toHaveBeenCalledTimes(2)
})

it('all 4,096 racing recovery attempts count and bypass ordinary replan and transport retry budgets', async () => {
	const local = memStore(),
		remote = authority(memStore())
	await remote.commit([row('holder', { name: 'same', version: 'a:1' })])
	await local.commit([row('loser', { name: 'same' })])
	const install = vi
		.spyOn(local, 'commit')
		.mockRejectedValue(new GuardError({ version: { id: 'loser', is: 'b:loser' } }))
	const commit = vi.spyOn(remote, 'commit')
	await expect(sync(local, remote, { ...options(), retries: 3 })).rejects.toThrow(
		'recovery attempt limit exceeded'
	)
	expect(install).toHaveBeenCalledTimes(4096)
	expect(commit).toHaveBeenCalledTimes(4097)
}, 30_000)

it('1,000 successful recoveries can precede a page success', async () => {
	const local = memStore(),
		remote = authority(memStore())
	await remote.commit([row('mount', { type: 'mount', version: 'a:mount' })])
	// Each refusal changes the next authored row; the 128-row pages never land until all repairs finish.
	const sources = Array.from({ length: 1000 }, (_, i) =>
		row(`x${String(i).padStart(4, '0')}`, { parent: 'mount' })
	)
	await local.commit(sources)
	const recovery = memStore()
	await sync(local, remote, options(recovery))
	expect(await fileCopies(recovery)).toHaveLength(1000)
	expect((await scan(local)).filter((row) => row.deleted)).toHaveLength(1000)
}, 60_000)

it('a racing descendant outside the refusal page is adopted on the next attempt', async () => {
	const input = await branchCase()
	const child = row('child', { parent: 'x' })
	await input.local.commit([child])
	const arrival = row('child', { parent: ROOT, version: 'a:arrival' })
	const commit = input.remote.commit
	let raced = false
	input.remote.commit = async (rows, guards) => {
		if (!raced) {
			raced = true
			await commit([arrival])
		}
		await commit(rows, guards)
	}
	expect(await recover(input)).toEqual({ status: 'raced' })
	const conflict = await refusal(input.remote, input.rows)
	expect(conflict).toEqual(input.conflict)
	expect(await recover({ ...input, conflict })).toEqual({ status: 'applied' })
	expect(await input.local.get('child')).toEqual(arrival)
	expect(await input.remote.get('child')).toEqual(arrival)
})

it('copy verification failure does not settle either shared store', async () => {
	const input = await branchCase()
	const commit = input.recovery.commit
	input.recovery.commit = (rows, guards) =>
		rows.some((row) => row.name === 'x') ? Promise.resolve() : commit(rows, guards)
	expect(await recover(input)).toMatchObject({
		status: 'failed',
		error: { message: 'recovered row failed verification' }
	})
	expect(await input.remote.get('x')).toBeNull()
	expect(await input.local.get('x')).toEqual(input.source)
})

it('a guard on the captured directory catches new children before local retirement', async () => {
	const input = await branchCase()
	const original = input.local.commit
	let raced = false
	input.local.commit = async (rows, guards) => {
		if (!raced) {
			raced = true
			await original([{ ...input.source, version: 'b:changed' }, row('new-child', { parent: 'x' })])
		}
		await original(rows, guards)
	}
	expect(await recover(input)).toEqual({ status: 'raced' })
	expect(await input.local.get('new-child')).not.toBeNull()
	const conflict = await refusal(input.remote, [(await input.local.get('x')) as Node])
	expect(
		await recover({ ...input, rows: [(await input.local.get('x')) as Node], conflict })
	).toEqual({ status: 'applied' })
	expect(await input.local.get('new-child')).toMatchObject({ deleted: true })
	expect(
		(await manifests(input.recovery)).some((manifest) =>
			decodeRows(manifest.sources).some((row) => row.id === 'new-child')
		)
	).toBe(true)
})

it('semantic repairs resume own settlement ids even when another row caused the refusal', async () => {
	const input = await branchCase()
	const commit = input.local.commit
	input.local.commit = async () => {
		throw new Error('crash')
	}
	await recover(input)
	input.local.commit = commit
	const competing = row('a', { name: 'taken' })
	await input.local.commit([competing])
	await input.remote.commit([row('holder', { name: 'taken', version: 'a:holder' })])
	const rows = [competing, input.source]
	const conflict = await refusal(input.remote, rows)
	expect(conflict.kind).toBe('taken-name')
	expect(await recover({ ...input, rows, conflict })).toEqual({ status: 'applied' })
	expect(await input.local.get('x')).toMatchObject({ deleted: true })
	expect((await scan(input.local)).some((row) => row.name === 'x' && !row.deleted)).toBe(false)
})

it('a later valid authority parent permits adoption after child safety blocked settlement', async () => {
	const local = memStore(),
		remote = authority(memStore()),
		recovery = memStore()
	const source = row('D')
	await local.commit([source])
	await remote.commit([row('C', { parent: 'D', version: 'a:child' })])
	const opts = options(recovery)
	await expect(sync(local, remote, opts)).rejects.toThrow('settlement-has-children')
	const parent = row('D', { type: 'dir', version: 'a:parent' })
	await remote.commit([parent])
	await sync(local, remote, opts)
	expect(await local.get('D')).toEqual(parent)
	expect(await local.get('C')).toEqual(await remote.get('C'))
})

it.each([
	'invalid-parent',
	'has-children',
	'parent-cycle'
])('restores authority rows in place for %s without sending adopted rows back', async (kind) => {
	const local = memStore(),
		raw = memStore(),
		recovery = memStore(),
		remote = authority(raw)
	const directory = row('dir', { type: 'dir', version: 'a:dir' })
	const child = row('child', { parent: 'dir', type: 'dir', version: 'a:child' })
	const file = row('file', { version: 'a:file' })
	await remote.commit([directory, child, file])
	await local.commit([directory, child, file])
	const changed = {
		...directory,
		version: 'b:changed',
		...(kind === 'invalid-parent'
			? { parent: 'file' }
			: kind === 'has-children'
				? { type: 'file' as const }
				: { parent: 'child' })
	}
	await local.commit([changed])
	await sync(local, remote, options(recovery))
	expect(await local.get('dir')).toEqual(directory)
	expect(await local.get('child')).toEqual(child)
	expect(await remote.get('dir')).toEqual(directory)
	expect((await scan(raw)).some((row) => row.deleted)).toBe(false)
	const saved = (await manifests(recovery))[0]
	expect(decodeRows(saved.sources).find((row) => row.id === 'dir')).toEqual(changed)
})

it('cursor expiry during recovery still requests T21 bootstrap and leaves local rows intact', async () => {
	const input = await branchCase()
	vi.spyOn(input.remote, 'get').mockRejectedValue(new BootstrapRequiredError('hub'))
	await expect(sync(input.local, input.remote, options(input.recovery))).rejects.toMatchObject({
		peerId: 'hub',
		winnerId: 'hub'
	})
	expect(await input.local.get('x')).toEqual(input.source)
})
