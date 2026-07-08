/**
 * Layer 3 — `synced()` orchestration / lifecycle (ported to the path API).
 *
 * Drives the REAL `synced()` engine over two `memStorage` backends (two-folder
 * P2P: the `remote` backend is the shared store). These are the GREEN guardrails
 * that must keep passing after Phase 2; in Phase 1 they are RED because the
 * engine's push/pull/bootstrap call `SyncReplica` bodies that throw.
 *
 * The ino-sync-only cases (applyBatch fast-path, FsCursorExpiredError recovery)
 * are intentionally dropped — Phase 3 deletes that surface.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { memStorage } from './storage.mem'
import { REMOTE_SOURCE, synced } from './synced'
import { volume } from './volume'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('synced (lifecycle)', () => {
	const destroyers: Array<() => void> = []
	afterEach(() => {
		for (const d of destroyers.splice(0)) d()
	})
	function track<T extends { destroy(): void }>(vol: T): T {
		destroyers.push(() => vol.destroy())
		return vol
	}

	// ── Bootstrap ────────────────────────────────────────────────────────────
	it('downloads remote files to local on first start', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/hello.txt', enc.encode('hello world'))
		await remoteVol.mkdir('/docs')
		await remoteVol.writeFile('/docs/readme.txt', enc.encode('readme'))

		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		expect(dec.decode(await vol.readFile('/hello.txt'))).toBe('hello world')
		expect(dec.decode(await vol.readFile('/docs/readme.txt'))).toBe('readme')
	})

	// ── Push ─────────────────────────────────────────────────────────────────
	it('pushes local writes to remote on flush', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/pushed.txt', enc.encode('pushed content'))
		await vol.flush()
		expect(dec.decode(await volume(remote).readFile('/pushed.txt'))).toBe('pushed content')
	})

	it('pushes a newly created directory to remote', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.mkdir('/notes')
		await vol.writeFile('/notes/idea.txt', enc.encode('idea'))
		await vol.flush()
		expect(await volume(remote).exists('/notes/idea.txt')).toBe(true)
	})

	it('pushes renames without losing content', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/untitled.md', enc.encode('hello'))
		await vol.flush()
		await vol.rename('/untitled.md', '/hello.md')
		await vol.flush()
		expect(await volume(remote).exists('/untitled.md')).toBe(false)
		expect(dec.decode(await volume(remote).readFile('/hello.md'))).toBe('hello')
	})

	// ── Pull ─────────────────────────────────────────────────────────────────
	it('pulls remote writes to local on flush (two clients)', async () => {
		const remote = memStorage()
		const vol1 = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		const vol2 = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol1.writeFile('/from-client1.txt', enc.encode('client1 data'))
		await vol1.flush()
		await vol2.flush()
		expect(dec.decode(await vol2.readFile('/from-client1.txt'))).toBe('client1 data')
	})

	it('does not echo back own pushed writes', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/own.txt', enc.encode('mine'))
		await vol.flush()
		const before = (await volume(remote).readdir('/')).length
		await vol.flush()
		expect((await volume(remote).readdir('/')).length).toBe(before)
	})

	it('reflects a remote file update after sync', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/data.txt', enc.encode('version-1'))
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await remoteVol.writeFile('/data.txt', enc.encode('version-2'))
		await vol.flush()
		expect(dec.decode(await vol.readFile('/data.txt'))).toBe('version-2')
	})

	it('propagates file deletion from remote to local', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/to-delete.txt', enc.encode('bye'))
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await remoteVol.rm('/to-delete.txt')
		await vol.flush()
		expect(await vol.exists('/to-delete.txt')).toBe(false)
	})

	// ── watch integration ──────────────────────────────────────────────────────
	it('watch fires on a remote pull tagged REMOTE_SOURCE and invalidates the cache', async () => {
		const remote = memStorage()
		const remoteVol = volume(remote)
		await remoteVol.writeFile('/state.json', enc.encode('v1'))
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		expect(Number((await vol.stat('/state.json')).size)).toBe(2)

		let fired = 0
		const sources: Array<string | undefined> = []
		await vol.watch('/state.json', (e) => {
			fired++
			sources.push(e.source)
		})
		await remoteVol.writeFile('/state.json', enc.encode('longer-version-2'))
		await vol.flush()
		await new Promise((r) => setTimeout(r, 0))
		expect(fired).toBeGreaterThanOrEqual(1)
		expect(sources).toContain(REMOTE_SOURCE)
		expect(Number((await vol.stat('/state.json')).size)).toBe('longer-version-2'.length)
	})

	// ── Local-only exclusion ────────────────────────────────────────────────────
	it('never syncs /.state to remote', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/x.txt', enc.encode('x'))
		await vol.flush()
		expect(await volume(remote).exists('/.state')).toBe(false)
	})

	// ── Adoption ────────────────────────────────────────────────────────────────
	it('preserves un-pushed local files when first adopting a non-empty remote', async () => {
		const remote = memStorage()
		await volume(remote).writeFile('/remote.txt', enc.encode('from remote'))
		const local = memStorage()
		await volume(local).writeFile('/local-only.txt', enc.encode('my work'))
		const vol = track(await synced({ local, remote, interval: 99_999 }))
		await vol.flush()
		expect(dec.decode(await vol.readFile('/local-only.txt'))).toBe('my work')
		expect(dec.decode(await vol.readFile('/remote.txt'))).toBe('from remote')
		expect(await volume(remote).exists('/local-only.txt')).toBe(true)
	})

	// ── Lifecycle: pause / resume / flush ─────────────────────────────────────
	it('does not push while paused and pushes on resume', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		vol.pause()
		await vol.writeFile('/paused.txt', enc.encode('data'))
		expect(await volume(remote).exists('/paused.txt')).toBe(false)
		vol.resume()
		await vol.flush()
		expect(await volume(remote).exists('/paused.txt')).toBe(true)
	})

	it('flush() resolves only after the sync completes', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/check.txt', enc.encode('check'))
		await vol.flush()
		expect(await volume(remote).exists('/check.txt')).toBe(true)
	})

	it('concurrent flush() calls both resolve without error', async () => {
		const remote = memStorage()
		const vol = track(await synced({ local: memStorage(), remote, interval: 99_999 }))
		await vol.writeFile('/a.txt', enc.encode('a'))
		const results = await Promise.allSettled([vol.flush(), vol.flush()])
		expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
	})

	// ── Local-first boot + status ──────────────────────────────────────────────
	it('localFirst returns the local volume immediately (write/read work at once)', async () => {
		const remote = memStorage()
		const vol = track(
			await synced({ local: memStorage(), remote, localFirst: true, interval: 99_999 })
		)
		await vol.writeFile('/note.txt', enc.encode('hi'))
		expect(dec.decode(await vol.readFile('/note.txt'))).toBe('hi')
	})

	it('reports error status when a sync fails', async () => {
		// A P2P remote whose scan rejects forces the loop into the error branch.
		const broken = memStorage()
		Object.assign(broken.caps ?? {}, {
			journal: {
				append: () => Promise.reject(new Error('boom')),
				readFrom: () => Promise.reject(new Error('boom')),
				head: () => Promise.reject(new Error('boom'))
			}
		})
		const vol = track(
			await synced({ local: memStorage(), remote: broken, localFirst: true, interval: 99_999 })
		)
		await vol.flush()
		expect(vol.status()).toBe('error')
	})

	it('notifies status subscribers as a sync settles', async () => {
		const remote = memStorage()
		const vol = track(
			await synced({ local: memStorage(), remote, localFirst: true, interval: 99_999 })
		)
		const seen: string[] = []
		vol.onStatusChange((s) => seen.push(s))
		await vol.flush()
		expect(seen).toContain('synced')
	})
})
