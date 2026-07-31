// Custody for the daemon's creds-at-rest key (A2's `secretCodec`): a macOS Keychain
// generic password, created on first run and read through the `security` CLI — no
// native binding, so it survives a `bun build --compile` binary, and the item stays
// scoped to the user's login keychain. Never written to the Volume: deleting the
// volume must not delete this, and deleting this must not resurrect plaintext (A2's
// `clearSecretCodec` refuses a sealed record with no key rather than reading it as-is).
//
// The key is resolved on FIRST USE of the codec, never at boot (see `lazySecretCodec`):
// a Keychain this daemon cannot read must break the ONE lane that needs it — where A2
// already degrades a record to "re-connect" — not the kernel, which also carries files,
// apps, devkit and notify.

import { aesGcmSecretCodec, type SecretCodec } from '@justfiles/app/capabilities/accounts/host'

const SERVICE = 'app.justfiles.kodama'
const ACCOUNT = 'accounts-key'
const KEY_BYTES = 32

// The seam a test stubs: a `security` that never succeeds must make key resolution THROW,
// never fall back to an unkeyed — plaintext — codec. Real callers never pass this.
export type Spawn = (
	cmd: readonly string[],
	input?: string
) => {
	readonly exited: Promise<number>
	text(): Promise<string>
}

// A new key goes in on `input` (stdin), never in argv: on macOS `ps -Ao args` shows another
// user's full command line, and `add-generic-password -w` with no value reads the password
// from stdin — twice, the way it would from a terminal (prompt, then confirmation).
const realSpawn: Spawn = (cmd, input) => {
	const proc = Bun.spawn([...cmd], {
		stdin: input === undefined ? 'ignore' : new Blob([input]),
		stdout: 'pipe',
		stderr: 'ignore'
	})
	return { exited: proc.exited, text: () => new Response(proc.stdout).text() }
}

async function run(
	spawn: Spawn,
	cmd: readonly string[],
	input?: string
): Promise<{ code: number; out: string }> {
	const proc = spawn(cmd, input)
	const [code, out] = await Promise.all([proc.exited, proc.text()])
	return { code, out }
}

async function readItem(
	spawn: Spawn,
	service: string,
	account: string
): Promise<Uint8Array | undefined> {
	const found = await run(spawn, [
		'security',
		'find-generic-password',
		'-s',
		service,
		'-a',
		account,
		'-w'
	])
	if (found.code !== 0) return undefined
	const bytes = Buffer.from(found.out.trim(), 'base64')
	// Fail closed on a malformed item (empty/truncated/garbage) rather than silently deriving
	// from it: `Buffer.from(_, 'base64')` is permissive, and a wrong-length "key" would seal
	// new records under a weak root while making every existing envelope unreadable — both
	// indistinguishable from a rotated key until it's too late. `security delete-generic-
	// password -s app.justfiles.kodama` re-mints a clean one on the next account operation.
	if (bytes.length !== KEY_BYTES) {
		throw new Error(
			`keychain: stored item ${service}/${account} is not a valid ${KEY_BYTES}-byte key`
		)
	}
	return bytes
}

// Read this daemon's key, minting it on first run. Deliberately NOT memoised — the one
// read-per-process cache belongs to `lazySecretCodec` below, which leaves this a plain
// function whose tests really do drive a (test-scoped) Keychain item instead of a cache.
export async function getOrCreateKey(
	service = SERVICE,
	account = ACCOUNT,
	spawn: Spawn = realSpawn
): Promise<Uint8Array> {
	const found = await readItem(spawn, service, account)
	if (found) return found

	// Not found (the common case) — mint one and store it WITHOUT replacing an existing item
	// (no `-U`): the daemon has no single-writer lock yet (Launcher.swift), so two processes
	// starting concurrently on a fresh install can both miss the read above. Only one `add`
	// wins. `-w` LAST, with no value, is the documented argv-safe form — `security`'s own help
	// says "Specify -w as the last option to be prompted" — and it reads the value from stdin
	// twice (prompt, then confirmation).
	const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
	const b64 = Buffer.from(bytes).toString('base64')
	const created = await run(
		spawn,
		['security', 'add-generic-password', '-s', service, '-a', account, '-w'],
		`${b64}\n${b64}\n`
	)

	// Return what the Keychain HOLDS, never the bytes we just generated — they can differ even
	// on a zero exit, and sealing records under a key the item does not contain is the one
	// unrecoverable outcome here (every credential reads as "re-connect" after a restart, with
	// nothing to point at). Two ways they diverge: a concurrent create won the name, or the
	// prompt above consumed a partial stdin, re-prompted, and stored an EMPTY password while
	// still exiting 0. So the item is the source of truth, and a value that is not a 32-byte
	// key fails closed via `readItem` rather than being used.
	const stored = await readItem(spawn, service, account)
	if (stored) return stored
	// The exit code is the diagnosis (44 = no such item, 45 = duplicate item, and `security
	// error <code>` decodes the rest) — worth carrying, since `security`'s own stderr is
	// discarded so that a prompt or a password never reaches the daemon's log.
	throw new Error(
		`keychain: could not create item ${service}/${account} (security exit ${created.code})`
	)
}

// A2's codec over a key fetched on FIRST USE and cached for the process: building this reads
// nothing, so a kernel boots (and a steady-state boot with nothing to reseal stays) free of
// Keychain access, and one hit then serves every account read/write. A failed fetch is
// evicted, so the next account operation retries rather than the lane staying dead until the
// daemon restarts.
export function lazySecretCodec(key: () => Promise<Uint8Array>): SecretCodec {
	let once: Promise<SecretCodec> | undefined
	const codec = (): Promise<SecretCodec> => {
		once ??= key()
			.then((bytes) => aesGcmSecretCodec(Buffer.from(bytes).toString('base64')))
			.catch((error: unknown) => {
				once = undefined
				throw error
			})
		return once
	}
	return {
		encode: async (creds, accountId) => (await codec()).encode(creds, accountId),
		decode: async (raw, accountId) => (await codec()).decode(raw, accountId)
	}
}

// The daemon's one codec — every reader and writer of the accounts store shares it.
export const accountsSecretCodec: SecretCodec = lazySecretCodec(() => getOrCreateKey())
