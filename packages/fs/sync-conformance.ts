/**
 * Backend conformance suite for path-based sync.
 *
 * The same path-sync semantics, run against EVERY owned backend (mem, IDB,
 * SQLite/DO) so the shipping backends — not just the `memStorage` test double —
 * are proven against identical specs. Cases are framework-agnostic (no `vitest`
 * / `bun:test` import): each is `{ name, run(makeBackend) }`, and every runner
 * (vitest for mem+idb, `bun:test` for sqlite) registers them with its own
 * `test()`.
 *
 * A case throws on failure. A backend that has not yet implemented the path-sync
 * seams (`caps.journal` / `caps.pathApply` / `caps.content` + local-mutation
 * journaling) fails these for the RIGHT reason (`not implemented`) — they are the
 * RED that turns GREEN as each backend lands.
 */

import type { BackendFactory } from './sync-test-harness'
import { bytes, text, twoPeers } from './sync-test-harness'
import { FileType } from './types'

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual !== expected)
		throw new Error(`conformance: ${msg} — expected ${String(expected)}, got ${String(actual)}`)
}

export interface ConformanceCase {
	name: string
	run(makeBackend: BackendFactory): Promise<void>
}

/** The shared cases. Each exercises the core seams (journal deltas, apply, blobs). */
export const pathSyncConformanceCases: ConformanceCase[] = [
	{
		name: 'converges a create by path (delta + apply + blob-by-hash)',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/data/note.txt', bytes('hello'))
			await syncBoth()
			assertEq(text(await client.readFile('/data/note.txt')), 'hello', 'create did not converge')
		}
	},
	{
		name: 'propagates a delete across a divergent tree',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/app/x/f', bytes('S'))
			await client.writeFile('/app/x/f', bytes('C'))
			await syncBoth()
			await server.rm('/app/x', { recursive: true })
			await syncBoth()
			assertEq(await client.exists('/app/x'), false, 'delete did not propagate')
		}
	},
	{
		name: 'converges an in-place update with zero orphaned inodes',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/a/f', bytes('v1'))
			await syncBoth()
			await server.writeFile('/a/f', bytes('v2'))
			await syncBoth()
			assertEq(text(await client.readFile('/a/f')), 'v2', 'update did not converge')
			assertEq(await client.orphanCount(), 0, 'orphaned inodes after in-place update')
		}
	},
	{
		name: 'moves a directory subtree on rename',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/old/a', bytes('1'))
			await server.writeFile('/old/b', bytes('2'))
			await syncBoth()
			await server.rename('/old', '/new')
			await syncBoth()
			assertEq(await client.exists('/old'), false, 'old dir survived rename')
			assertEq(text(await client.readFile('/new/a')), '1', 'moved child /new/a missing')
			assertEq(text(await client.readFile('/new/b')), '2', 'moved child /new/b missing')
		}
	},
	{
		name: 'syncs a symlink by target',
		run: async (makeBackend) => {
			const { client, server, syncBoth } = twoPeers({ makeBackend })
			await server.writeFile('/target.txt', bytes('data'))
			await server.symlink('/target.txt', '/link')
			await syncBoth()
			assertEq((await client.lstat('/link')).type, FileType.Symlink, '/link is not a symlink')
			assertEq(await client.readlink('/link'), '/target.txt', 'symlink target wrong')
		}
	}
]
