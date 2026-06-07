import { RpcSession, RpcTarget } from 'capnweb'
import { expect, test } from 'vitest'
import { transportPair } from './rpc.testpair.ts'

// A trivial RpcTarget — pass-by-reference, its methods callable over RPC.
class Echo extends RpcTarget {
	echo(x: unknown): unknown {
		return x
	}
}

// Proves the dep runs under node/vitest and the in-memory pair carries a session:
// a value, plus the two types the JSON wire could never do — Uint8Array (bytes
// survive) and bigint.
test('capnweb round-trips a value, Uint8Array and bigint over the transport pair', async () => {
	const [a, b] = transportPair()
	new RpcSession(b, new Echo())
	const remote = new RpcSession<Echo>(a).getRemoteMain()

	expect(await remote.echo(42)).toBe(42)

	const back = (await remote.echo(new Uint8Array([1, 2, 3]))) as Uint8Array
	expect(Array.from(back)).toEqual([1, 2, 3])

	expect(await remote.echo(10n)).toBe(10n)
})
