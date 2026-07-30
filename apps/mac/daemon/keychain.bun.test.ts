// Keychain custody coverage (Bun-only, like the daemon's other `*.bun.test.ts` files).
// The `security` CLI is macOS-only — this suite is meant to be run by a human on a
// Mac (see the "Verify" section of #294), not from Linux CI. Real Keychain items sit
// under a test-scoped service name so nothing here ever touches the daemon's own
// `app.justfiles.kodama` item.

import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOrCreateKey } from './keychain.ts'

const SERVICE = `app.justfiles.kodama.test.${Date.now()}`
const ACCOUNT = 'accounts-key'

afterAll(() => {
	Bun.spawnSync(['security', 'delete-generic-password', '-s', SERVICE, '-a', ACCOUNT])
})

test('creates a 32-byte item on first read', async () => {
	const key = await getOrCreateKey(SERVICE, ACCOUNT)
	expect(key).toBeInstanceOf(Uint8Array)
	expect(key.length).toBe(32)
})

test('a second call is idempotent — same bytes, no rotation', async () => {
	expect(await getOrCreateKey(SERVICE, ACCOUNT)).toEqual(await getOrCreateKey(SERVICE, ACCOUNT))
})

test('resolves even after the support dir is gone — custody is the Keychain, not the Volume', async () => {
	const prev = process.env.FRIEREN_SUPPORT_DIR
	const dir = await mkdtemp(join(tmpdir(), 'kodama-support-'))
	process.env.FRIEREN_SUPPORT_DIR = dir
	await rm(dir, { recursive: true, force: true })
	expect(await getOrCreateKey(SERVICE, ACCOUNT)).toEqual(await getOrCreateKey(SERVICE, ACCOUNT))
	process.env.FRIEREN_SUPPORT_DIR = prev
})

test('a spawn that cannot read or write throws — never falls back to an unkeyed codec', async () => {
	const failing = () => ({ exited: Promise.resolve(1), text: async () => '' })
	await expect(getOrCreateKey('kodama.test.unreadable', ACCOUNT, failing)).rejects.toThrow()
})

test('loses a create race but returns the Keychain winner, not its own bytes', async () => {
	// Two daemons starting concurrently on a fresh install can both miss the initial read (no
	// single-writer lock yet — Launcher.swift). Only one `add` wins; the loser must re-read and
	// return the WINNER's bytes, or it would encrypt with a key nothing else agrees on.
	const winner = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
	let lostTheRace = false
	const spawn = (cmd: readonly string[]) => {
		if (cmd[1] === 'find-generic-password') {
			return lostTheRace
				? { exited: Promise.resolve(0), text: async () => winner }
				: { exited: Promise.resolve(1), text: async () => '' }
		}
		lostTheRace = true // the `add` lost to a concurrent writer
		return { exited: Promise.resolve(1), text: async () => '' }
	}
	const key = await getOrCreateKey('kodama.test.race', ACCOUNT, spawn)
	expect(Buffer.from(key).toString('base64')).toBe(winner)
})
