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
import { getOrCreateKey, lazySecretCodec, type Spawn } from './keychain.ts'

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
				: { exited: Promise.resolve(1), text: async () => '' }
		}
		lostTheRace = true // the `add` lost to a concurrent writer
		return { exited: Promise.resolve(1), text: async () => '' }
	}
	const key = await getOrCreateKey('kodama.test.race', ACCOUNT, spawn)
	expect(b64(key)).toBe(winner)
})

test('a new key is written on stdin, never in argv — `ps -Ao args` shows another user command line', async () => {
	let addCmd: readonly string[] = []
	let addInput: string | undefined
	const spawn: Spawn = (cmd, input) => {
		const adding = cmd[1] === 'add-generic-password'
		if (adding) {
			addCmd = cmd
			addInput = input
		}
		return { exited: Promise.resolve(adding ? 0 : 1), text: async () => '' }
	}
	const key = await getOrCreateKey('kodama.test.argv', ACCOUNT, spawn)
	expect(addCmd.at(-1)).toBe('-w') // the flag, with no value after it
	expect(addCmd).not.toContain(b64(key))
	expect(addInput).toBe(`${b64(key)}\n${b64(key)}\n`) // prompt + confirmation
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
