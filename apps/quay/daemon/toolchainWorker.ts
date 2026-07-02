// The quay toolchain worker ENTRY — the one file that runs on the worker thread.
// It binds quay's real backends (`Bun.build` compile + the tsc typecheck) to the
// portable `serveToolchain` loop, so every devkit compile/typecheck the agent
// triggers runs HERE instead of on the daemon's event loop. `tsTypecheck`'s
// multi-second synchronous `ts.createProgram` now blocks only this thread; the
// daemon keeps serving UI requests and app sockets throughout.
//
// Kept warm by the daemon (see `./toolchain.ts`): the 8 MB `typescript` module and
// its parsed `lib.*.d.ts` stay resident across the agent's repeated checks, so
// each run also gets faster, not just non-blocking.
//
// Bun's `Worker` is web-style: the isolate talks over the `self` global, exactly
// like a browser Web Worker — so the transport glue is identical to frieren's.
// `declare var self` is Bun's recommended way to type it without pulling the
// `webworker` lib into the project (which would clash with the daemon's globals).

import { bunCompile } from '@justfiles/app/toolchain/bun'
import { tsTypecheck } from '@justfiles/app/toolchain/typescript'
import { serveToolchain } from '@justfiles/app/toolchain/worker'
import * as ts from 'typescript'

declare var self: Worker

serveToolchain(
	{
		compile: bunCompile,
		// `tsTypecheck` is synchronous and returns a `CheckResult`; `Promise.resolve`
		// lifts it into the async backend shape. Blocking is fine — it's this thread.
		typecheck: (input, types, paths) => Promise.resolve(tsTypecheck(input, ts, types, paths))
	},
	{
		post: (message) => self.postMessage(message),
		onMessage: (handler) => {
			self.onmessage = (event) => handler(event.data)
		}
	}
)
