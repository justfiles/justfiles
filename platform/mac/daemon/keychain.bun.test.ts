// Keychain custody coverage (Bun-only, like the daemon's other `*.bun.test.ts` files).
// The `security` CLI is macOS-only — this suite is meant to be run by a human on a
// Mac (see the "Verify" section of #294), not from Linux CI. Real Keychain items sit
// under a test-scoped service name so nothing here ever touches the daemon's own
// `app.justfiles.kodama` item.
//
// `getOrCreateKey` is deliberately unmemoised (the one-read-per-process cache belongs to
// `lazySecretCodec`), so every assertion below really goes to the Keychain — including the
// "same bytes" ones, which would otherwise only be re-reading a promise.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOrCreateKey, keychainStore, lazySecretCodec, type Spawn } from './keychain.ts'

const SERVICE = `app.justfiles.kodama.test.${Date.now()}`
const ACCOUNT = 'accounts-key'

// What the Keychain itself holds, read independently of the code under test.
const stored = (): string =>
	Bun.spawnSync(['security', 'find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'])
		.stdout.toString()
		.trim()

const b64 = (key: Uint8Array): string => Buffer.from(key).toString('base64')

afterAll(() => {
	Bun.spawnSync(['security', 'delete-generic-password', '-s', SERVICE, '-a', ACCOUNT])
})

test('creates a 32-byte item on first read, and returns exactly what the Keychain now holds', async () => {
	const key = await getOrCreateKey(SERVICE, ACCOUNT)
	expect(key).toBeInstanceOf(Uint8Array)
	expect(key.length).toBe(32)
	expect(b64(key)).toBe(stored())
})

test('a second call re-reads the same item — no rotation on every boot', async () => {
	const before = stored()
	expect(before).not.toBe('')
	expect(b64(await getOrCreateKey(SERVICE, ACCOUNT))).toBe(before)
	// …and nothing was re-minted behind it.
	expect(stored()).toBe(before)
})

test('resolves with the support dir gone — custody is the Keychain, not the Volume', async () => {
	const prev = process.env.FRIEREN_SUPPORT_DIR
	const dir = await mkdtemp(join(tmpdir(), 'kodama-support-'))
	process.env.FRIEREN_SUPPORT_DIR = dir
	await rm(dir, { recursive: true, force: true })
	try {
		expect(b64(await getOrCreateKey(SERVICE, ACCOUNT))).toBe(stored())
	} finally {
		if (prev === undefined) delete process.env.FRIEREN_SUPPORT_DIR
		else process.env.FRIEREN_SUPPORT_DIR = prev
	}
})

test('a spawn that cannot read or write throws — never falls back to an unkeyed codec', async () => {
	const failing: Spawn = () => ({ exited: Promise.resolve(1), text: async () => '' })
	await expect(getOrCreateKey('kodama.test.unreadable', ACCOUNT, failing)).rejects.toThrow()
})

test('a malformed stored key (wrong length) throws — fails closed rather than deriving from garbage', async () => {
	const malformed: Spawn = () => ({
		exited: Promise.resolve(0),
		text: async () => Buffer.from('too-short').toString('base64')
	})
	await expect(getOrCreateKey('kodama.test.malformed', ACCOUNT, malformed)).rejects.toThrow()
})

test('loses a create race but returns the Keychain winner, not its own bytes', async () => {
	// Two daemons starting concurrently on a fresh install can both miss the initial read (no
	// single-writer lock yet — Launcher.swift). Only one `add` wins; the loser must re-read and
	// return the WINNER's bytes, or it would encrypt with a key nothing else agrees on.
	const winner = b64(crypto.getRandomValues(new Uint8Array(32)))
	let lostTheRace = false
	const spawn: Spawn = (cmd) => {
		if (cmd[1] === 'find-generic-password') {
			return lostTheRace
				? { exited: Promise.resolve(0), text: async () => winner }
				: { exited: Promise.resolve(44), text: async () => '' }
		}
		lostTheRace = true // the `add` lost to a concurrent writer
		return { exited: Promise.resolve(45), text: async () => '' }
	}
	const key = await getOrCreateKey('kodama.test.race', ACCOUNT, spawn)
	expect(b64(key)).toBe(winner)
})

test('a new key is written on stdin, never in argv — `ps -Ao args` shows another user command line', async () => {
	let addCmd: readonly string[] = []
	let addInput: string | undefined
	// A `security` faithful enough to matter: the `add` stores the FIRST stdin line (that is
	// what the prompt consumes) and later reads serve it back.
	let item = '' // the Keychain: empty until the add lands
	const spawn: Spawn = (cmd, input) => {
		if (cmd[1] === 'add-generic-password') {
			addCmd = cmd
			addInput = input
			item = input?.split('\n')[0] ?? ''
			return { exited: Promise.resolve(0), text: async () => '' }
		}
		return item
			? { exited: Promise.resolve(0), text: async () => item }
			: { exited: Promise.resolve(44), text: async () => '' }
	}
	const key = await getOrCreateKey('kodama.test.argv', ACCOUNT, spawn)
	expect(addCmd.at(-1)).toBe('-w') // the flag last, with no value — `security`'s prompt form
	expect(addCmd).not.toContain(b64(key))
	expect(addInput).toBe(`${b64(key)}\n${b64(key)}\n`) // prompt + confirmation
	expect(b64(key)).toBe(item) // and the key we return is the one the item holds
})

test('an add that exits 0 while storing something else never returns the bytes we minted', async () => {
	// The prompt form's sharp edge: fed a partial stdin, `security` re-prompts, takes the empty
	// second read, and stores an EMPTY password — exiting 0 all the same (verified against the
	// real CLI). Trusting that exit code would seal every record under a key the Keychain does
	// not hold, which surfaces only as "re-connect" for ALL accounts after the next restart.
	let finds = 0
	const spawn: Spawn = (cmd) => {
		if (cmd[1] === 'add-generic-password')
			return { exited: Promise.resolve(0), text: async () => '' } // "succeeded"
		finds++
		// First read: no such item (44). Read-back after the add: found, but EMPTY — what the
		// real CLI stores when its prompt consumes a partial stdin and takes the empty retype.
		return finds === 1
			? { exited: Promise.resolve(44), text: async () => '' }
			: { exited: Promise.resolve(0), text: async () => '' }
	}
	await expect(getOrCreateKey('kodama.test.emptied', ACCOUNT, spawn)).rejects.toThrow(
		'not a valid 32-byte key'
	)
})

// The string-item store (E1's custody of the platform OAuth refresh token). The end-to-end
// custody path runs in identity.bun.test.ts against the real CLI; these two pin the contract
// that identity.ts leans on, and both are `security` behaviours a fake has to be told about.
describe('keychainStore', () => {
	test('a missing item and an unreadable Keychain are DIFFERENT answers', async () => {
		// 44 = errSecItemNotFound, i.e. "no grant" — an answer. A locked keychain or a denied prompt
		// is not: reported as absent, it would publish "signed out" over a perfectly good grant and
		// cache that for the rest of the daemon's run.
		const missing: Spawn = () => ({ exited: Promise.resolve(44), text: async () => '' })
		const locked: Spawn = () => ({ exited: Promise.resolve(51), text: async () => '' })
		expect(await keychainStore(ACCOUNT, 'kodama.test.absent', missing).read()).toBeUndefined()
		await expect(keychainStore(ACCOUNT, 'kodama.test.locked', locked).read()).rejects.toThrow(
			'security exit 51'
		)
	})

	test('a write that did not land throws instead of reporting success', async () => {
		// Same sharp edge as the key path: `security`'s prompt form can exit 0 having stored nothing.
		// A silent no-op here would tell identity.ts a rotation was recorded when it was not, which
		// is exactly how a grant dies on the next refresh.
		const pretends: Spawn = (cmd) =>
			cmd[1] === 'add-generic-password'
				? { exited: Promise.resolve(0), text: async () => '' }
				: { exited: Promise.resolve(44), text: async () => '' }
		await expect(
			keychainStore(ACCOUNT, 'kodama.test.nowrite', pretends).write('rt-1')
		).rejects.toThrow('could not store')
	})
})

// The codec the kernel is actually wired with. Its whole point is WHEN the key is read:
// never at boot, so a Keychain failure costs the credential lane and not the daemon.
describe('lazySecretCodec', () => {
	const KEY = crypto.getRandomValues(new Uint8Array(32))

	test('reads no key until the first encode/decode, then one for the whole process', async () => {
		let reads = 0
		const codec = lazySecretCodec(async () => {
			reads++
			return KEY
		})
		expect(reads).toBe(0) // building it — i.e. booting the kernel — touches nothing
		const sealed = await codec.encode({ password: 'p' }, 'acct')
		await codec.decode(sealed, 'acct')
		expect(reads).toBe(1)
	})

	test('a key that cannot be read fails that operation, and the NEXT one retries', async () => {
		let reads = 0
		const codec = lazySecretCodec(async () => {
			reads++
			if (reads === 1) throw new Error('keychain: locked')
			return KEY
		})
		// Fails closed: the write is refused, not downgraded to plaintext.
		await expect(codec.encode({ password: 'p' }, 'acct')).rejects.toThrow('locked')
		// The daemon kept running, and the next account operation heals.
		const sealed = await codec.encode({ password: 'p' }, 'acct')
		expect(JSON.stringify(sealed)).not.toContain('password')
		expect(await codec.decode(sealed, 'acct')).toEqual({ password: 'p' })
	})
})
