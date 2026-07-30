// Custody for the daemon's creds-at-rest key (A2's `secretCodec`): a macOS Keychain
// generic password, created on first run and read through the `security` CLI — no
// native binding, so it survives a `bun build --compile` binary, and the item stays
// scoped to the user's login keychain. Never written to the Volume: deleting the
// volume must not delete this, and deleting this must not resurrect plaintext (A2's
// `clearSecretCodec` refuses a sealed record with no key rather than reading it as-is).

const SERVICE = 'app.justfiles.kodama'
const ACCOUNT = 'accounts-key'
const KEY_BYTES = 32

// The seam a test stubs (a `security` call that never succeeds must make
// `getOrCreateKey` throw, never fall back to an unkeyed — plaintext — codec).
// Real callers never pass this; it defaults to a real `Bun.spawn`.
export type Spawn = (cmd: readonly string[]) => {
	readonly exited: Promise<number>
	text(): Promise<string>
}

const realSpawn: Spawn = (cmd) => {
	const proc = Bun.spawn([...cmd], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
	return { exited: proc.exited, text: () => new Response(proc.stdout).text() }
}

async function run(spawn: Spawn, cmd: readonly string[]): Promise<{ code: number; out: string }> {
	const proc = spawn(cmd)
	const [code, out] = await Promise.all([proc.exited, proc.text()])
	return { code, out }
}

// One Keychain hit per (service, account) per process — a prompt-free read for an
// item this process created, never re-derived on every call. A failed attempt is
// evicted so a transient error doesn't poison every later call.
const pending = new Map<string, Promise<Uint8Array>>()

export function getOrCreateKey(
	service = SERVICE,
	account = ACCOUNT,
	spawn: Spawn = realSpawn
): Promise<Uint8Array> {
	const cacheKey = `${service}\u0000${account}`
	let promise = pending.get(cacheKey)
	if (!promise) {
		promise = resolve(service, account, spawn).catch((error: unknown) => {
			pending.delete(cacheKey)
			throw error
		})
		pending.set(cacheKey, promise)
	}
	return promise
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
	// password` + a restart re-mints a clean one.
	if (bytes.length !== KEY_BYTES) {
		throw new Error(
			`keychain: stored item ${service}/${account} is not a valid ${KEY_BYTES}-byte key`
		)
	}
	return bytes
}

async function resolve(service: string, account: string, spawn: Spawn): Promise<Uint8Array> {
	const found = await readItem(spawn, service, account)
	if (found) return found

	// Not found (the common case) — mint one and store it WITHOUT replacing an existing item
	// (no `-U`): the daemon has no single-writer lock yet (Launcher.swift), so two processes
	// starting concurrently on a fresh install can both miss the read above. Only one `add`
	// wins; the loser's bytes are never stored, so returning them would encrypt with a key
	// nothing else agrees on. Keychain is the source of truth either way — re-read on a lost
	// race (or any other add failure) and use whatever is actually stored.
	const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
	const created = await run(spawn, [
		'security',
		'add-generic-password',
		'-s',
		service,
		'-a',
		account,
		'-w',
		Buffer.from(bytes).toString('base64')
	])
	if (created.code === 0) return bytes

	const winner = await readItem(spawn, service, account)
	if (winner) return winner
	throw new Error(`keychain: could not create item ${service}/${account}`)
}
