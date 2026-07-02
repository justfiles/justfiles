// The daemon's handle to the toolchain worker: spawn it lazily on first devkit
// use (a session that never compiles pays nothing — mirrors the sysroot lazy
// load), keep it warm, and expose the two backend functions `kernel.ts` hands to
// `devkitCapability`. A crash fails every in-flight call and drops the handle, so
// the next call transparently respawns a fresh worker.
//
// `new URL('./toolchainWorker.ts', import.meta.url)` is the canonical form Bun
// statically detects to (a) resolve the script in `bun --watch` dev and (b) TRACE
// AND EMBED the worker's whole graph (bunCompile + tsc) — BUT only if the worker is
// also listed as a second `--compile` entrypoint (see build-exe.ts); Bun does not
// yet auto-embed workers found via `new Worker(new URL(...))`.
//
// Shipped, the reference must differ: bundling flattens `import.meta.url` to the exe
// path (`/$bunfs/root/<exe>`), so `new URL(...)` resolves to a bunfs path Bun's
// embedded-worker registry doesn't match. Bun registers each embedded entrypoint
// under its path relative to the entrypoints' common root — both daemon entries live
// in `daemon/`, so the worker's key is `./toolchainWorker.ts`, matched by a plain
// relative `new Worker(...)` string, cwd-independently (verified from a foreign cwd).
// `Bun.isStandaloneExecutable`/`embeddedFiles` are empty on 1.3.x, so we branch on
// the existing SHIPPED build-time define instead.

import { type ToolchainClient, toolchainClient } from '@justfiles/app/toolchain/worker'
import { SHIPPED } from '../quayd/resources'

const WORKER_SPEC = SHIPPED
	? './toolchainWorker.ts'
	: new URL('./toolchainWorker.ts', import.meta.url).href

let client: ToolchainClient | undefined

export function toolchain(): ToolchainClient {
	if (client) return client

	const worker = new Worker(WORKER_SPEC)
	// Don't let the warm worker keep the daemon alive at shutdown — the daemon owns
	// its lifetime and terminates it on exit paths implicitly by exiting.
	worker.unref()

	const c = toolchainClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.addEventListener('message', (event) => handler(event.data))
	})

	// A dead worker must never leave a compile/typecheck hung: reject in-flight
	// calls and drop the handle so the next `toolchain()` spawns a fresh one.
	const die = (error: Error): void => {
		if (client !== c) return
		client = undefined
		c.fail(error)
		worker.terminate()
	}
	worker.addEventListener('error', (event) =>
		die(event.error ?? new Error(event.message ?? 'toolchain worker error'))
	)
	worker.addEventListener('close', (event) =>
		die(new Error(`toolchain worker closed: ${event.code}`))
	)

	client = c
	return c
}
