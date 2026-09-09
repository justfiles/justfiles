// Kernel/capability wiring coverage — the daemon has no host.ts,
// so this drives `buildKernel` over a throwaway temp Volume: the kernel + the shared
// reducer sandbox pool + `volumeCapability` over a real native-FS Volume. Files declares
// the `volume` capability with the `system` scope (the daemon's one systemAllowlist entry), so
// calling `listDirectories` reads an actual volume folder — proving a capability-using reducer
// reaches real files, not a stub. The per-app `/data/<id>` chroot and non-allowlisted
// `system` denial live in the package-level capability tests; here we lock in the daemon's
// own wiring. Bun-only (`bun test`): the reducer sandbox uses blob-URL Workers.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aesGcmSecretCodec, type SecretCodec } from '@justfiles/app/accounts/host'
import type { Kernel } from '@justfiles/app/runtime'
import { volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { buildKernel, daemonAccounts, daemonSettings } from './kernel.ts'
import { sandboxes } from './sandbox.ts'

const FILES = 'justfiles.files'
const SETTINGS = 'justfiles.settings'
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
	const fs = volume(fsStore(root))
	kernel = await buildKernel(fs, daemonAccounts(fs))
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

test('seeds the builtin catalog into the fresh Volume', async () => {
	const ids = (await kernel.list()).map((app) => app.id)
	// reconcile ran during buildKernel — the launcher's catalog is populated.
	expect(ids).toContain(FILES)
	expect(ids).not.toContain(SETTINGS)
	// Code is NOT seeded (see builtins.ts): it installs from the App Store tile.
	expect(ids).not.toContain('justfiles.code')
})

test('Files reads the real volume through the system-scoped volume capability', async () => {
	sandboxes.retain(FILES)
	try {
		const result = (await kernel.dispatch(FILES, {
			type: 'listDirectories',
			params: { paths: ['/applications'] }
		})) as { path: string; entries: { name: string }[] }[]
		expect(result[0]?.path).toBe('/applications')
		expect(result[0]?.entries.map((entry) => entry.name)).toContain(FILES)
	} finally {
		sandboxes.release(FILES)
	}
})

test('soul preview reports unavailable when no AI account is enabled', async () => {
	const fs = volume(fsStore(await tempRoot('no-ai')))
	const settings = daemonSettings(fs, daemonAccounts(fs, { getToken: async () => null }))
	await expect(settings.generateSoul({ name: 'Fern', gender: 'female' })).rejects.toThrow(
		'SETTINGS_UNAVAILABLE'
	)
})

test('a secretCodec passed to the host seals the accounts store at rest (A4)', async () => {
	const sealedRoot = await tempRoot('sealed')
	const sealedFs = volume(fsStore(sealedRoot))
	const sealed = daemonSettings(
		sealedFs,
		daemonAccounts(sealedFs, { secretCodec: aesGcmSecretCodec('a-test-root-secret') })
	)

	await sealed.connectAccount({
		providerId: 'icloud',
		credentials: { username: 'me@example.com', password: 'SEKRIT-APP-PASSWORD' }
	})

	const state = { accounts: await sealed.listAccounts({}) }
	expect(state.accounts.map((a) => a.accountId)).toContain('me@example.com')

	// And the raw file on disk carries no plaintext credential substring.
	const raw = await readFile(
		join(sealedRoot, 'private', 'accounts', `${encodeURIComponent('me@example.com')}.json`),
		'utf8'
	)
	expect(raw).not.toContain('SEKRIT-APP-PASSWORD')
})

test('a secretCodec passed to the host seals PRE-EXISTING plaintext accounts on boot (upgrade path)', async () => {
	const upgradeRoot = await tempRoot('upgrade')

	// Connect an account with no codec — exactly what every account on disk before this
	// feature landed looks like.
	const clearFs = volume(fsStore(upgradeRoot))
	const clear = daemonSettings(clearFs, daemonAccounts(clearFs))
	await clear.connectAccount({
		providerId: 'icloud',
		credentials: { username: 'old@example.com', password: 'PRE-EXISTING-PW' }
	})
	const accountPath = join(
		upgradeRoot,
		'private',
		'accounts',
		`${encodeURIComponent('old@example.com')}.json`
	)
	// Wait for the asynchronous credential reseal sweep.
	await poll(
		() => readFile(accountPath, 'utf8').catch(() => ''),
		(raw) => raw.includes('PRE-EXISTING-PW')
	)

	// Reboot the SAME Volume with a key now available — nothing ever rewrites this record
	// (an iCloud app-specific password is written once, at connect), so only a reseal sweep
	// on boot can close the gap.
	const upgradedFs = volume(fsStore(upgradeRoot))
	daemonAccounts(upgradedFs, { secretCodec: aesGcmSecretCodec('a-test-root-secret') })
	// The sweep is best-effort and never awaited — nothing may wait on a credential being
	// sealed — so this polls for it rather than reading once.
	await poll(
		() => readFile(accountPath, 'utf8'),
		(raw) => !raw.includes('PRE-EXISTING-PW')
	)
})

test('a kernel whose key can never be read still boots — the creds lane degrades, the daemon does not (A4)', async () => {
	const deadRoot = await tempRoot('nokey')
	// A pre-A4 plaintext record, so the boot reseal sweep has work to do — and hits the wall.
	const clearFs = volume(fsStore(deadRoot))
	const clear = daemonSettings(clearFs, daemonAccounts(clearFs))
	await clear.connectAccount({
		providerId: 'icloud',
		credentials: { username: 'old@example.com', password: 'STILL-HERE-PW' }
	})
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
	const deadFs = volume(fsStore(deadRoot))
	const dead = await buildKernel(deadFs, daemonAccounts(deadFs, { secretCodec: locked }))

	// It BOOTED: a failed reseal sweep is best-effort, and files/apps/devkit/notify carry on.
	expect((await dead.list()).map((app) => app.id)).toContain(FILES)
	// The credential it could not seal is still there, unharmed — a key that comes back (the
	// keychain unlocks) seals it on the next boot; nothing was destroyed in the meantime.
	expect(await readFile(oldPath, 'utf8')).toContain('STILL-HERE-PW')

	// And a NEW connect fails closed — no plaintext credential on disk, no daemon crash.
	const settings = daemonSettings(deadFs, daemonAccounts(deadFs, { secretCodec: locked }))
	await expect(
		settings.connectAccount({
			providerId: 'icloud',
			credentials: { username: 'x@example.com', password: 'UNSEALABLE-PW' }
		})
	).rejects.toThrow()

	const raw = await readFile(
		join(deadRoot, 'private', 'accounts', `${encodeURIComponent('x@example.com')}.json`),
		'utf8'
	).catch(() => '')
	expect(raw).not.toContain('UNSEALABLE-PW')
})
