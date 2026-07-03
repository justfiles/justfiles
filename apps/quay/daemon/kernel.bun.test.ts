// Kernel/capability wiring coverage — the daemon has no host.ts,
// so this drives `buildKernel` over a throwaway temp Volume: the kernel + the shared
// reducer sandbox pool + `volumeCapability` over a real native-FS Volume. Files declares
// the `volume` capability with the `system` scope (quay's one systemAllowlist entry), so
// dispatching `refresh` scans the actual volume root — proving a capability-using reducer
// reaches real files, not a stub. The per-app `/data/<id>` chroot and non-allowlisted
// `system` denial live in the package-level capability tests; here we lock in the daemon's
// own wiring. Bun-only (`bun test`): the reducer sandbox uses blob-URL Workers.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kernel, Message } from '@justfiles/app/runtime'
import { volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { buildKernel } from './kernel.ts'
import { sandboxes } from './sandbox.ts'

const FILES = 'app.frieren.files'
let root: string
let kernel: Kernel

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'quay-daemon-kernel-'))
	kernel = await buildKernel(volume(await nativeStorage(root)))
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

type FilesState = { loading: boolean; files: Array<{ path: string }> }

test('seeds the builtin catalog into the fresh Volume', async () => {
	const ids = (await kernel.list()).map((app) => app.id)
	// reconcileBuiltins ran during buildKernel — the launcher's catalog is populated.
	expect(ids).toContain(FILES)
	expect(ids).toContain('app.code')
	expect(ids).toContain('app.justfiles.counter')
})

test('Files reads the real volume through the system-scoped volume capability', async () => {
	sandboxes.retain(FILES) // pin its reducer worker the way an open window would
	await kernel.dispatch(FILES, { type: 'refresh', params: {} } as Message)

	// refresh emits `volume.scan` over the `system` scope; its result folds back as
	// `filesLoaded`, clearing `loading`. Poll until the scan has settled.
	const state = await poll(
		() => kernel.state(FILES) as Promise<FilesState>,
		(s) => !s.loading
	)

	// The scan walked the seeded volume — every built-in bundle lives under
	// /applications, so the root scope sees real, on-disk files.
	expect(state.files.length).toBeGreaterThan(0)
	expect(state.files.some((f) => f.path.startsWith('/applications/'))).toBe(true)

	sandboxes.release(FILES)
})
