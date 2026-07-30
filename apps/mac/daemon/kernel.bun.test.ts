// Kernel/capability wiring coverage — the daemon has no host.ts,
// so this drives `buildKernel` over a throwaway temp Volume: the kernel + the shared
// reducer sandbox pool + `volumeCapability` over a real native-FS Volume. Files declares
// the `volume` capability with the `system` scope (the daemon's one systemAllowlist entry), so
// dispatching `refresh` scans the actual volume root — proving a capability-using reducer
// reaches real files, not a stub. The per-app `/data/<id>` chroot and non-allowlisted
// `system` denial live in the package-level capability tests; here we lock in the daemon's
// own wiring. Bun-only (`bun test`): the reducer sandbox uses blob-URL Workers.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aesGcmSecretCodec } from '@justfiles/app/capabilities/accounts/host'
import type { Kernel, Message } from '@justfiles/app/runtime'
import { volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { buildKernel } from './kernel.ts'
import { sandboxes } from './sandbox.ts'

const FILES = 'app.justfiles.frieren.files'
let root: string
let kernel: Kernel

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'daemon-kernel-'))
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

type FilesState = { files: Array<{ path: string }> }

test('seeds the builtin catalog into the fresh Volume', async () => {
	const ids = (await kernel.list()).map((app) => app.id)
	// reconcile ran during buildKernel — the launcher's catalog is populated.
	expect(ids).toContain(FILES)
	expect(ids).toContain('app.justfiles.frieren.code')
})

test('Files reads the real volume through the system-scoped volume capability', async () => {
	sandboxes.retain(FILES) // pin its reducer worker the way an open window would
	await kernel.dispatch(FILES, { type: 'refresh', params: {} } as Message)

	// refresh emits a coalesced `volume.scan` over the `system` scope; its result
	// folds back as `filesLoaded`, populating `files`. Poll until the scan lands.
	const state = await poll(
		() => kernel.state(FILES) as Promise<FilesState>,
		(s) => s.files.length > 0
	)

	// The scan walked the seeded volume — every built-in bundle lives under
	// /applications, so the root scope sees real, on-disk files.
	expect(state.files.length).toBeGreaterThan(0)
	expect(state.files.some((f) => f.path.startsWith('/applications/'))).toBe(true)

	sandboxes.release(FILES)
})

test('a secretCodec passed to buildKernel seals the accounts store at rest (A4)', async () => {
	const SETTINGS = 'app.justfiles.frieren.settings'
	const sealedRoot = await mkdtemp(join(tmpdir(), 'daemon-kernel-sealed-'))
	const sealed = await buildKernel(volume(await nativeStorage(sealedRoot)), {
		secretCodec: aesGcmSecretCodec('a-test-root-secret')
	})

	// A form provider (iCloud) round-tripped through the daemon's REAL wiring: the
	// settings app's `connectAccount` procedure invoking the `settings` capability's
	// `accounts.connect`, which is `buildKernel`'s own `accountsCapabilities(...)`.
	await sealed.dispatch(SETTINGS, {
		type: 'connectAccount',
		params: {
			providerId: 'icloud',
			credentials: { username: 'me@example.com', password: 'SEKRIT-APP-PASSWORD' }
		}
	} as Message)

	// The raw file on disk carries no plaintext credential substring.
	const raw = await readFile(
		join(sealedRoot, 'private', 'accounts', `${encodeURIComponent('me@example.com')}.json`),
		'utf8'
	)
	expect(raw).not.toContain('SEKRIT-APP-PASSWORD')

	// And it reads back through the SAME kernel/codec — the round trip.
	const state = await poll(
		() => sealed.state(SETTINGS) as Promise<{ accounts: Array<{ accountId: string }> }>,
		(s) => s.accounts.length > 0
	)
	expect(state.accounts.map((a) => a.accountId)).toContain('me@example.com')

	await rm(sealedRoot, { recursive: true, force: true })
})

test('a secretCodec passed to buildKernel seals PRE-EXISTING plaintext accounts on boot (upgrade path)', async () => {
	const SETTINGS = 'app.justfiles.frieren.settings'
	const upgradeRoot = await mkdtemp(join(tmpdir(), 'daemon-kernel-upgrade-'))

	// Connect an account with no codec — exactly what every account on disk before this
	// feature landed looks like.
	const clear = await buildKernel(volume(await nativeStorage(upgradeRoot)))
	await clear.dispatch(SETTINGS, {
		type: 'connectAccount',
		params: {
			providerId: 'icloud',
			credentials: { username: 'old@example.com', password: 'PRE-EXISTING-PW' }
		}
	} as Message)
	const accountPath = join(
		upgradeRoot,
		'private',
		'accounts',
		`${encodeURIComponent('old@example.com')}.json`
	)
	expect(await readFile(accountPath, 'utf8')).toContain('PRE-EXISTING-PW')

	// Reboot the SAME Volume with a key now available — nothing ever rewrites this record
	// (an iCloud app-specific password is written once, at connect), so only a reseal sweep
	// on boot can close the gap.
	await buildKernel(volume(await nativeStorage(upgradeRoot)), {
		secretCodec: aesGcmSecretCodec('a-test-root-secret')
	})
	expect(await readFile(accountPath, 'utf8')).not.toContain('PRE-EXISTING-PW')

	await rm(upgradeRoot, { recursive: true, force: true })
})
