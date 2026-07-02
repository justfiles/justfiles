// The portable devkit-worker wire: a transport-agnostic RPC that runs the
// `compile`/`typecheck` backends off the calling thread. Pure message-plumbing —
// type-only imports, no Bun/Node/DOM/esbuild deps — so the SAME module drives a
// Bun `worker_thread` (quay), a browser Web Worker (frieren), or anything else
// that can move messages. Only two things differ per host and live outside this
// file: which backends the worker imports (quay = `Bun.build` + tsc; frieren =
// esbuild-wasm, no typecheck) and the ~2-line transport glue.
//
// `toolchainClient` presents the EXACT signatures `devkitCapability` already
// expects for its `compile`/`typecheck` seams — `(input, runtime) => …` and
// `(input, types, paths) => …` — so swapping the worker in is a drop-in: the host
// passes `client.compile`/`client.typecheck` where it used to pass the in-process
// backend functions, and nothing else in the pipeline changes.

import type {
	CheckResult,
	CompileResult,
	ProjectInput,
	TypePaths,
	TypesBundle
} from './toolchain.ts'

// Host→worker request frames, correlated by `id`. `runtime`/`types`/`paths` ride
// along per call: they're plain `Record<string,string>` maps that structured-clone
// cheaply, and re-sending them costs nothing next to a multi-second `createProgram`.
type RequestBody =
	| { op: 'compile'; input: ProjectInput; runtime: Record<string, string> }
	| { op: 'typecheck'; input: ProjectInput; types: TypesBundle; paths: TypePaths }
type Request = RequestBody & { id: string }

// Worker→host reply: the backend's result, or a serialized throw (a normal
// compile/typecheck failure comes back as `ok:true` with diagnostics — `ok:false`
// is only for an unexpected crash in the backend).
type Reply =
	| { id: string; ok: true; result: CompileResult | CheckResult }
	| { id: string; ok: false; error: WireError }

type WireError = { message: string; stack?: string }

// The two message primitives every transport reduces to. `post`/`send` move one
// frame; `onMessage`/`listen` deliver each incoming frame's payload (already
// unwrapped from any `MessageEvent`).
export type ToolchainTransport = {
	post: (message: unknown) => void
	onMessage: (handler: (message: unknown) => void) => void
}

// The client's surface: the compile/typecheck backend signatures verbatim, plus
// `fail` to reject every in-flight call when the worker dies (so a crashed worker
// is never awaited forever).
export type ToolchainClient = {
	compile: (input: ProjectInput, runtime: Record<string, string>) => Promise<CompileResult>
	typecheck: (input: ProjectInput, types: TypesBundle, paths: TypePaths) => Promise<CheckResult>
	fail: (error: Error) => void
}

// Wrap a transport as a `ToolchainClient`. Requests are correlated by a monotonic
// id; replies resolve/reject the matching promise.
export function toolchainClient(transport: ToolchainTransport): ToolchainClient {
	let nextId = 0
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

	transport.onMessage((raw) => {
		const reply = raw as Reply
		const p = pending.get(reply.id)
		if (!p) return
		pending.delete(reply.id)
		if (reply.ok) p.resolve(reply.result)
		else p.reject(Object.assign(new Error(reply.error.message), { stack: reply.error.stack }))
	})

	const request = <T>(body: RequestBody): Promise<T> => {
		const id = String(nextId++)
		return new Promise<T>((resolve, reject) => {
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
			transport.post({ id, ...body })
		})
	}

	return {
		compile: (input, runtime) => request<CompileResult>({ op: 'compile', input, runtime }),
		typecheck: (input, types, paths) =>
			request<CheckResult>({ op: 'typecheck', input, types, paths }),
		fail: (error) => {
			for (const [, p] of pending) p.reject(error)
			pending.clear()
		}
	}
}

// The backends a worker binds. `typecheck` is optional: a host without a type
// checker (frieren's browser esbuild-wasm) omits it, and a `typecheck` request
// then rejects — but such a host simply never wires `client.typecheck` into
// `devkitCapability`, so the factory degrades typecheck to CAPABILITY_UNAVAILABLE
// and the request is never sent in the first place.
export type ToolchainBackends = {
	compile: (input: ProjectInput, runtime: Record<string, string>) => Promise<CompileResult>
	typecheck?: (input: ProjectInput, types: TypesBundle, paths: TypePaths) => Promise<CheckResult>
}

// The worker-side loop: service each request by calling the injected backend and
// posting its result (or a serialized throw). Runs on the worker's thread, so a
// blocking backend (tsc's synchronous `createProgram`) blocks only here — the
// host's event loop stays free, which is the whole point.
export function serveToolchain(backends: ToolchainBackends, transport: ToolchainTransport): void {
	transport.onMessage((raw) => {
		const req = raw as Request
		void (async () => {
			try {
				const result =
					req.op === 'compile'
						? await backends.compile(req.input, req.runtime)
						: await typecheck(backends, req)
				transport.post({ id: req.id, ok: true, result } satisfies Reply)
			} catch (error) {
				transport.post({ id: req.id, ok: false, error: toWire(error) } satisfies Reply)
			}
		})()
	})
}

function typecheck(
	backends: ToolchainBackends,
	req: Extract<Request, { op: 'typecheck' }>
): Promise<CheckResult> {
	if (!backends.typecheck) throw new Error('toolchain worker has no typecheck backend')
	return backends.typecheck(req.input, req.types, req.paths)
}

function toWire(error: unknown): WireError {
	return error instanceof Error
		? { message: error.message, stack: error.stack }
		: { message: String(error) }
}
