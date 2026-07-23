/**
 * Unit tests for the anti-entropy reconcile (the sync convergence backstop).
 *
 * Driven through the REAL `twoPeers()` replicas (two independent backends), so
 * these exercise `reconcile()` against the same `pathScan`/`applyPathChanges`/LWW
 * seams production uses — not a re-implementation. The headline property: two
 * replicas holding DIFFERENT content at the SAME path always converge to one
 * deterministic winner on BOTH sides (the exact bug this feature fixes).
 */

import { describe, expect, it } from 'vitest'
import { reconcile } from './anti-entropy'
import { bytes, text, twoPeers } from './sync-test-harness'

describe('reconcile — convergence backstop', () => {
	it('is a no-op on an already-converged pair (no applies, no blob transfer)', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.writeFile('/a.txt', bytes('hello'))
		await syncBoth()

		// Count blob fetches to prove converged content moves zero bytes.
		let fetches = 0
		const spied = {
			...server.replica,
			getBlobByHash: (h: string) => {
				fetches++
				return server.replica.getBlobByHash(h)
			}
		}
		const res = await reconcile(client.replica, spied)
		expect(res.pulled).toBe(0)
		expect(res.pushed).toBe(0)
		expect(fetches).toBe(0)
	})

	it('pulls a remote-only file down to local', async () => {
		const { client, server } = twoPeers()
		await server.writeFile('/only-remote.txt', bytes('R'))
		const res = await reconcile(client.replica, server.replica)
		expect(res.pulled).toBe(1)
		expect(text(await client.readFile('/only-remote.txt'))).toBe('R')
	})

	it('pushes a local-only file up to remote', async () => {
		const { client, server } = twoPeers()
		await client.writeFile('/only-local.txt', bytes('L'))
		const res = await reconcile(client.replica, server.replica)
		expect(res.pushed).toBe(1)
		expect(text(await server.readFile('/only-local.txt'))).toBe('L')
	})

	it('converges same-path divergent content to the higher version (remote wins)', async () => {
		const { client, server } = twoPeers()
		await client.write('/x', bytes('C'), { version: 2 })
		await server.write('/x', bytes('S'), { version: 5 })
		await reconcile(client.replica, server.replica)
		expect(text(await client.readFile('/x'))).toBe('S')
		expect(text(await server.readFile('/x'))).toBe('S')
	})

	it('converges same-path divergent content to the higher version (local wins)', async () => {
		const { client, server } = twoPeers()
		await client.write('/x', bytes('C'), { version: 5 })
		await server.write('/x', bytes('S'), { version: 2 })
		await reconcile(client.replica, server.replica)
		expect(text(await client.readFile('/x'))).toBe('C')
		expect(text(await server.readFile('/x'))).toBe('C')
	})

	it('converges an EXACT-version tie to one deterministic winner on both sides (no swap)', async () => {
		// This is the pixel bug: both sides drew different art at the same path, same
		// version. The digest tie-break must pick the SAME winner on both replicas.
		const { client, server } = twoPeers()
		await client.write('/pixel', bytes('heart'), { version: 3 })
		await server.write('/pixel', bytes('jelly'), { version: 3 })
		await reconcile(client.replica, server.replica)
		const c = text(await client.readFile('/pixel'))
		const s = text(await server.readFile('/pixel'))
		expect(c).toBe(s) // converged, not diverged
		expect(['heart', 'jelly']).toContain(c)
	})

	it('converges meta-only divergence at an equal version (regular file, mode differs, same content)', async () => {
		// contentHash + version match on both sides, so a contentHash-only "agree" would
		// call this converged and never run the durable-state tie-break — leaving the
		// mode permanently split. mtime pinned equal so mode is the ONLY difference.
		const { client, server } = twoPeers()
		await client.write('/f', bytes('same'), { version: 4, mode: 0o644, mtimeNs: 1000 })
		await server.write('/f', bytes('same'), { version: 4, mode: 0o600, mtimeNs: 1000 })
		await reconcile(client.replica, server.replica)
		const cm = (await client.stat('/f')).mode & 0o777
		const sm = (await server.stat('/f')).mode & 0o777
		expect(cm).toBe(sm) // converged on ONE mode, not left split
		expect([0o644, 0o600]).toContain(cm)
		const again = await reconcile(client.replica, server.replica)
		expect(again).toMatchObject({ pulled: 0, pushed: 0 })
	})

	it('converges directory mode divergence at an equal version (no contentHash to compare)', async () => {
		// A directory carries no contentHash, so the old contentHash-only agree treated
		// ANY two same-version dirs as converged — mode drift never healed. The digest
		// tie-break must now split it deterministically on both sides.
		const { client, server } = twoPeers()
		await client.mkdir('/d', { version: 4, mode: 0o755, mtimeNs: 1000 })
		await server.mkdir('/d', { version: 4, mode: 0o700, mtimeNs: 1000 })
		await reconcile(client.replica, server.replica)
		const cm = (await client.stat('/d')).mode & 0o777
		const sm = (await server.stat('/d')).mode & 0o777
		expect(cm).toBe(sm) // converged, not left split
		expect([0o755, 0o700]).toContain(cm)
	})

	it('is idempotent — a second pass over the converged pair does nothing', async () => {
		const { client, server } = twoPeers()
		await client.write('/x', bytes('C'), { version: 3 })
		await server.write('/x', bytes('S'), { version: 3 })
		await reconcile(client.replica, server.replica)
		const again = await reconcile(client.replica, server.replica)
		expect(again.pulled).toBe(0)
		expect(again.pushed).toBe(0)
	})

	it('reports zero work when both sides are empty', async () => {
		const { client, server } = twoPeers()
		const res = await reconcile(client.replica, server.replica)
		expect(res).toMatchObject({ localPaths: 0, remotePaths: 0, pulled: 0, pushed: 0 })
	})

	it('never crosses the local-only /.state subtree', async () => {
		const { client, server } = twoPeers()
		await server.writeFile('/.state/secret', bytes('X'))
		const res = await reconcile(client.replica, server.replica)
		expect(await client.exists('/.state/secret')).toBe(false)
		expect(res.pulled).toBe(0)
	})

	it('propagates a higher-versioned tombstone (a missed delete) to the stale live side', async () => {
		const { client, server } = twoPeers()
		// The client missed the delete: it still holds a live put; the server deleted the
		// path at a higher version. The tombstone must propagate so the stale file goes.
		await client.write('/x', bytes('C'), { version: 2 })
		await server.write('/x', bytes('S'), { version: 5 })
		await server.rm('/x') // tombstone at version 6 (> the client's live put at 2)
		const res = await reconcile(client.replica, server.replica)
		expect(res.pulled).toBe(1) // the tombstone is pulled down to the client
		expect(await client.exists('/x')).toBe(false) // stale live put removed — converged
		expect(await server.exists('/x')).toBe(false)
		// Idempotent: both sides now hold the same tombstone, so a second pass is a no-op.
		const again = await reconcile(client.replica, server.replica)
		expect(again).toMatchObject({ pulled: 0, pushed: 0 })
	})

	it('propagates a local tombstone up to a stale live remote (missed delete, other direction)', async () => {
		const { client, server } = twoPeers()
		// The server missed the delete: it still holds a live put; the client deleted the
		// path at a higher version.
		await server.write('/x', bytes('S'), { version: 2 })
		await client.write('/x', bytes('C'), { version: 5 })
		await client.rm('/x') // local tombstone at version 6 (> the server's live put at 2)
		const res = await reconcile(client.replica, server.replica)
		expect(res.pushed).toBe(1) // the tombstone is pushed up to the server
		expect(await server.exists('/x')).toBe(false) // converged
		expect(await client.exists('/x')).toBe(false)
	})

	it('settles a subtree delete-vs-add-child conflict without churning on the ancestor tombstone', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.mkdir('/d')
		await syncBoth() // both hold /d
		// Concurrent + cursor-missed: the client deletes /d; the server adds a NEW child.
		await client.rm('/d', { recursive: true }) // client tombstones /d
		await server.writeFile('/d/x', bytes('child')) // /d stays live on the server, gains /d/x
		const first = await reconcile(client.replica, server.replica)
		// The surviving child is pulled down (resurrecting /d on the client); the ancestor
		// tombstone is NOT propagated (it can never beat the live subtree).
		expect(text(await client.readFile('/d/x'))).toBe('child')
		expect(await client.exists('/d')).toBe(true)
		expect(await server.exists('/d/x')).toBe(true)
		expect(first.pushed).toBe(0) // the shadowed tombstone was skipped, not pushed
		// And it SETTLES: a second pass does no work (no infinite ancestor-tombstone churn).
		const again = await reconcile(client.replica, server.replica)
		expect(again).toMatchObject({ pulled: 0, pushed: 0 })
	})

	it('reconciles a mixed batch in one pass (pull + push + skip)', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.writeFile('/shared.txt', bytes('same'))
		await syncBoth() // converged — must be skipped
		await server.writeFile('/r.txt', bytes('remote')) // pull
		await client.writeFile('/l.txt', bytes('local')) // push
		const res = await reconcile(client.replica, server.replica)
		expect(res.pulled).toBe(1)
		expect(res.pushed).toBe(1)
		expect(text(await client.readFile('/r.txt'))).toBe('remote')
		expect(text(await server.readFile('/l.txt'))).toBe('local')
		// And a re-run settles to zero (full convergence).
		const again = await reconcile(client.replica, server.replica)
		expect(again).toMatchObject({ pulled: 0, pushed: 0 })
	})
})
