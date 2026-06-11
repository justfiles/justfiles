import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@justfiles/app/runtime'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createHost, type Host } from './host.ts'

// Slice 9 acceptance — capabilities in-process, end to end through quay's REAL
// wiring: the kernel + a nodeSandbox worker_thread + `volumeCapability` over a real
// native-FS Volume. Finder declares the `volume` capability with the `system` scope
// (it's quay's one systemAllowlist entry), so dispatching `refresh` scans the actual
// volume root — proving a capability-using reducer reaches real files, not a stub.
// The per-app `/data/<id>` chroot and non-allowlisted `system` denial are covered by
// the package-level capability/scope tests; here we lock in quay's own wiring.

const FINDER = 'app.frieren.finder'
let root: string
let host: Host

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'quayd-host-'))
	host = await createHost(root)
})
afterAll(async () => {
	await rm(root, { recursive: true, force: true })
})

async function poll<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
	for (let i = 0; i < 400; i++) {
		const v = await read()
		if (ok(v)) return v
		await new Promise((r) => setTimeout(r, 5))
	}
	throw new Error('poll timed out')
}

type FinderState = { loading: boolean; files: Array<{ path: string }> }

test('Finder reads the real volume through the system-scoped volume capability', async () => {
	host.sandbox.retain(FINDER) // pin its worker the way an open window would
	await host.kernel.dispatch(FINDER, { type: 'refresh', params: {} } as Message)

	// refresh emits `volume.scan` over the `system` scope; its result folds back as
	// `filesLoaded`, clearing `loading`. Poll until the scan has settled.
	const state = await poll(
		() => host.kernel.state(FINDER) as Promise<FinderState>,
		(s) => !s.loading
	)

	// The scan walked the seeded volume — every built-in bundle lives under
	// /applications, so the root scope sees real, on-disk files.
	expect(state.files.length).toBeGreaterThan(0)
	expect(state.files.some((f) => f.path.startsWith('/applications/'))).toBe(true)

	host.sandbox.release(FINDER)
})
