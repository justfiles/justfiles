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
import { aesGcmSecretCodec, type SecretCodec } from '@justfiles/app/capabilities/accounts/host'
import type { Kernel, Message } from '@justfiles/app/runtime'
import { volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { buildKernel } from './kernel.ts'
import { sandboxes } from './sandbox.ts'

const FILES = 'app.justfiles.frieren.files'
const SETTINGS = 'app.justfiles.frieren.settings'
let root: string
let kernel: Kernel

// Every temp Volume this file builds a kernel over, torn down together at the very end: a
// kernel keeps live reducer workers (the shared `sandboxes` pool) over its Volume, so
// deleting one mid-suite makes a later worker load fail an unrelated test with ENOENT.
const roots: string[] = []
const tempRoot = async (name: string): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), `daemon-kernel-${name}-`))
	roots.push(dir)
	return dir
}

beforeAll(async () => {
	root = await tempRoot('')
	kernel = await buildKernel(volume(await nativeStorage(root)))
})
afterAll(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true })
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
	const sealedRoot = await tempRoot('sealed')
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

	// It reads back through the SAME kernel/codec — the round trip. Polled first, because
	// `connectAccount` completes asynchronously: the account surfacing in state is what proves
	// the record has been written, so the raw file below is there to read.
	const state = await poll(
		() => sealed.state(SETTINGS) as Promise<{ accounts: Array<{ accountId: string }> }>,
		(s) => s.accounts.length > 0
	)
	expect(state.accounts.map((a) => a.accountId)).toContain('me@example.com')

	// And the raw file on disk carries no plaintext credential substring.
	const raw = await readFile(
		join(sealedRoot, 'private', 'accounts', `${encodeURIComponent('me@example.com')}.json`),
		'utf8'
	)
	expect(raw).not.toContain('SEKRIT-APP-PASSWORD')
})

test('a secretCodec passed to buildKernel seals PRE-EXISTING plaintext accounts on boot (upgrade path)', async () => {
	const upgradeRoot = await tempRoot('upgrade')

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
	// Polled, not read once: `connectAccount` completes asynchronously.
	await poll(
		() => readFile(accountPath, 'utf8').catch(() => ''),
		(raw) => raw.includes('PRE-EXISTING-PW')
	)

	// Reboot the SAME Volume with a key now available — nothing ever rewrites this record
	// (an iCloud app-specific password is written once, at connect), so only a reseal sweep
	// on boot can close the gap.
	await buildKernel(volume(await nativeStorage(upgradeRoot)), {
		secretCodec: aesGcmSecretCodec('a-test-root-secret')
	})
	expect(await readFile(accountPath, 'utf8')).not.toContain('PRE-EXISTING-PW')
})

test('a kernel whose key can never be read still boots — the creds lane degrades, the daemon does not (A4)', async () => {
	const deadRoot = await tempRoot('nokey')
	// A pre-A4 plaintext record, so the boot reseal sweep has work to do — and hits the wall.
	const clear = await buildKernel(volume(await nativeStorage(deadRoot)))
	await clear.dispatch(SETTINGS, {
		type: 'connectAccount',
		params: {
			providerId: 'icloud',
			credentials: { username: 'old@example.com', password: 'STILL-HERE-PW' }
		}
	} as Message)
	const oldPath = join(
		deadRoot,
		'private',
		'accounts',
		`${encodeURIComponent('old@example.com')}.json`
	)
	await poll(
		() => readFile(oldPath, 'utf8').catch(() => ''),
		(raw) => raw.includes('STILL-HERE-PW')
	)

	// A Keychain that cannot be read (locked login keychain, denied ACL, malformed item): the
	// real codec resolves its key lazily, so this is what every account operation then sees.
	const locked: SecretCodec = {
		encode: () => {
			throw new Error('keychain: locked')
		},
		decode: () => {
			throw new Error('keychain: locked')
		}
	}
	const dead = await buildKernel(volume(await nativeStorage(deadRoot)), { secretCodec: locked })

	// It BOOTED: a failed reseal sweep is best-effort, and files/apps/devkit/notify carry on.
	expect((await dead.list()).map((app) => app.id)).toContain(FILES)
	// The credential it could not seal is still there, unharmed — a key that comes back (the
	// keychain unlocks) seals it on the next boot; nothing was destroyed in the meantime.
	expect(await readFile(oldPath, 'utf8')).toContain('STILL-HERE-PW')

	// And a NEW connect fails closed — no plaintext credential on disk, no daemon crash.
	await dead
		.dispatch(SETTINGS, {
			type: 'connectAccount',
			params: {
				providerId: 'icloud',
				credentials: { username: 'x@example.com', password: 'UNSEALABLE-PW' }
			}
		} as Message)
		.catch(() => {})
	const raw = await readFile(
		join(deadRoot, 'private', 'accounts', `${encodeURIComponent('x@example.com')}.json`),
		'utf8'
	).catch(() => '')
	expect(raw).not.toContain('UNSEALABLE-PW')
})
