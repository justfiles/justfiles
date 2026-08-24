// URL fetches stay on the host because the import session owns its cache, limits,
// and lock. The worker gets plain graph maps and asks the host for file bodies.

import {
	type CachedImport,
	type ImportGraph,
	type ResolvedImports,
	resolveImport
} from './imports.ts'
import type {
	CheckResult,
	CompileResult,
	ProjectInput,
	TypePaths,
	TypesBundle
} from './toolchain.ts'

type BareRequest =
	| { op: 'compile'; input: ProjectInput; runtime: Record<string, string> }
	| { op: 'typecheck'; input: ProjectInput; types: TypesBundle; paths: TypePaths }
type RunRequest = BareRequest & { kind: 'run'; id: string; imports?: ImportGraph }

type RunReply =
	| { kind: 'result'; id: string; ok: true; result: CompileResult | CheckResult }
	| { kind: 'result'; id: string; ok: false; error: WireError }

type LoadRequest = { kind: 'load'; id: string; runId: string; url: string }
type LoadReply =
	| { kind: 'loaded'; id: string; ok: true; value: CachedImport }
	| { kind: 'loaded'; id: string; ok: false; error: WireError }

type HostFrame = RunReply | LoadRequest
type WorkerFrame = RunRequest | LoadReply

type WireError = { message: string; stack?: string }
type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void }

export type ToolchainTransport = {
	post: (message: unknown) => void
	onMessage: (handler: (message: unknown) => void) => void
}

export type ToolchainClient = {
	compile: (
		input: ProjectInput,
		runtime: Record<string, string>,
		imports?: ResolvedImports
	) => Promise<CompileResult>
	typecheck: (
		input: ProjectInput,
		types: TypesBundle,
		paths: TypePaths,
		imports?: ResolvedImports
	) => Promise<CheckResult>
	fail: (error: Error) => void
}

export function toolchainClient(transport: ToolchainTransport): ToolchainClient {
	let nextId = 0
	const pending = new Map<string, Pending<unknown>>()
	const imports = new Map<string, ResolvedImports>()

	transport.onMessage((raw) => {
		const reply = raw as HostFrame
		if (reply.kind === 'load') {
			const graph = imports.get(reply.runId)
			if (!graph) {
				replyTo(transport, {
					kind: 'loaded',
					id: reply.id,
					ok: false,
					error: { message: 'import session ended' }
				})
				return
			}
			void graph.load(reply.url).then(
				(value) => replyTo(transport, { kind: 'loaded', id: reply.id, ok: true, value }),
				(error) =>
					replyTo(transport, {
						kind: 'loaded',
						id: reply.id,
						ok: false,
						error: toWire(error)
					})
			)
			return
		}
		if (reply.kind !== 'result') return
		const p = pending.get(reply.id)
		if (!p) return
		pending.delete(reply.id)
		imports.delete(reply.id)
		if (reply.ok) p.resolve(reply.result)
		else p.reject(Object.assign(new Error(reply.error.message), { stack: reply.error.stack }))
	})

	const request = <T>(body: BareRequest, graph?: ResolvedImports): Promise<T> => {
		const id = String(nextId++)
		return new Promise<T>((resolve, reject) => {
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
			if (graph) imports.set(id, graph)
			try {
				transport.post({
					kind: 'run',
					id,
					...body,
					...(graph
						? {
								imports: {
									code: graph.code,
									declarations: graph.declarations,
									limits: graph.limits
								}
							}
						: {})
				} satisfies RunRequest)
			} catch (error) {
				pending.delete(id)
				imports.delete(id)
				reject(error)
			}
		})
	}

	return {
		compile: (input, runtime, graph) =>
			request<CompileResult>({ op: 'compile', input, runtime }, graph),
		typecheck: (input, types, paths, graph) =>
			request<CheckResult>({ op: 'typecheck', input, types, paths }, graph),
		fail: (error) => {
			for (const [, p] of pending) p.reject(error)
			pending.clear()
			imports.clear()
		}
	}
}

export type ToolchainBackends = {
	compile: (
		input: ProjectInput,
		runtime: Record<string, string>,
		imports?: ResolvedImports
	) => Promise<CompileResult>
	typecheck?: (
		input: ProjectInput,
		types: TypesBundle,
		paths: TypePaths,
		imports?: ResolvedImports
	) => Promise<CheckResult>
}

export function serveToolchain(backends: ToolchainBackends, transport: ToolchainTransport): void {
	let nextLoad = 0
	let jobs = Promise.resolve()
	const loads = new Map<string, Pending<CachedImport>>()
	transport.onMessage((raw) => {
		const req = raw as WorkerFrame
		if (req.kind === 'loaded') {
			const load = loads.get(req.id)
			if (!load) return
			loads.delete(req.id)
			if (req.ok) load.resolve(req.value)
			else load.reject(Object.assign(new Error(req.error.message), { stack: req.error.stack }))
			return
		}
		if (req.kind !== 'run') return
		jobs = jobs.then(async () => {
			try {
				const imports = req.imports
					? workerImports(req.id, req.imports, transport, loads, () => String(nextLoad++))
					: undefined
				const result =
					req.op === 'compile'
						? await backends.compile(req.input, req.runtime, imports)
						: await typecheck(backends, req, imports)
				replyTo(transport, {
					kind: 'result',
					id: req.id,
					ok: true,
					result
				} satisfies RunReply)
			} catch (error) {
				replyTo(transport, {
					kind: 'result',
					id: req.id,
					ok: false,
					error: toWire(error)
				} satisfies RunReply)
			}
		})
	})
}

function workerImports(
	runId: string,
	graph: ImportGraph,
	transport: ToolchainTransport,
	loads: Map<string, Pending<CachedImport>>,
	nextId: () => string
): ResolvedImports {
	return {
		...graph,
		load: (url) =>
			new Promise<CachedImport>((resolve, reject) => {
				const id = `${runId}:${nextId()}`
				loads.set(id, { resolve, reject })
				transport.post({ kind: 'load', id, runId, url } satisfies LoadRequest)
			}),
		resolve: (specifier, importer, kind) => resolveImport(graph, specifier, importer, kind),
		lock: () => {
			throw new Error('worker import proxy has no lock')
		},
		diagnostics: []
	}
}

function typecheck(
	backends: ToolchainBackends,
	req: Extract<RunRequest, { op: 'typecheck' }>,
	imports?: ResolvedImports
): Promise<CheckResult> {
	if (!backends.typecheck) throw new Error('toolchain worker has no typecheck backend')
	return backends.typecheck(req.input, req.types, req.paths, imports)
}

function replyTo(transport: ToolchainTransport, frame: LoadReply | RunReply): void {
	try {
		transport.post(frame)
	} catch {
		// The host can stop while an import or toolchain job is still ending.
	}
}

function toWire(error: unknown): WireError {
	return error instanceof Error
		? { message: error.message, stack: error.stack }
		: { message: String(error) }
}
