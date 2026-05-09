// Single-place dispatcher for client-only app JSON-RPC. Adding a method
// means adding one entry to `handlers` — types are pinned by the
// `AppRpcRegistry` map in `@justfiles/app/protocol`. The worker's WS loop
// hands every `app_rpc` frame here and ships the result back verbatim.

import {
	APP_RPC_ERROR,
	type AppRpcError,
	type AppRpcMethod,
	type AppRpcParams,
	type AppRpcResponse,
	type AppRpcResult,
	type RequestId
} from '@justfiles/app'
import type { Volume } from '@justfiles/fs'

export interface AppRpcContext {
	vol: Volume
	appId: string
}

type Handler<M extends AppRpcMethod> = (
	ctx: AppRpcContext,
	params: AppRpcParams<M>
) => Promise<AppRpcResult<M>>

class RpcError extends Error {
	constructor(readonly payload: AppRpcError) {
		super(payload.message)
	}
}

const fail = (e: AppRpcError): never => {
	throw new RpcError({ ...e })
}

// Reject paths that escape app-private storage or contain control bytes.
// Returns the volume-absolute path under `/apps/<appId>/private/`.
function privatePath(appId: string, raw: unknown): string {
	if (typeof raw !== 'string' || raw.length === 0) fail(APP_RPC_ERROR.invalidPath)
	const segments = (raw as string).split('/').filter((s) => s !== '' && s !== '.')
	if (segments.length === 0) fail(APP_RPC_ERROR.invalidPath)
	for (const s of segments) {
		if (s === '..' || s.includes('\0')) fail(APP_RPC_ERROR.invalidPath)
	}
	return `/apps/${appId}/private/${segments.join('/')}`
}

async function ensureParent(vol: Volume, fullPath: string): Promise<void> {
	const slash = fullPath.lastIndexOf('/')
	if (slash <= 0) return
	await vol.mkdir(fullPath.slice(0, slash), { recursive: true })
}

const isEnoent = (err: unknown): boolean => err instanceof Error && err.message.startsWith('ENOENT')

const requireString = (v: unknown): string =>
	typeof v === 'string' ? v : (fail(APP_RPC_ERROR.invalidPayload) as never)

function decodeBase64(s: unknown): Uint8Array {
	if (typeof s !== 'string') fail(APP_RPC_ERROR.invalidPayload)
	const str = s as string
	if (str.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(str)) {
		fail(APP_RPC_ERROR.invalidPayload)
	}
	try {
		const bin = atob(str)
		const u8 = new Uint8Array(bin.length)
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
		return u8
	} catch {
		return fail(APP_RPC_ERROR.invalidPayload) as never
	}
}

function encodeBase64(u8: Uint8Array): string {
	let bin = ''
	for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
	return btoa(bin)
}

const readBytes = async (vol: Volume, path: string): Promise<Uint8Array> => {
	try {
		return await vol.readFile(path)
	} catch (err) {
		if (isEnoent(err)) fail(APP_RPC_ERROR.notFound)
		throw err
	}
}

const handlers: { [M in AppRpcMethod]: Handler<M> } = {
	'app.volume.readText': async ({ vol, appId }, { path }) => {
		const bytes = await readBytes(vol, privatePath(appId, path))
		return { text: new TextDecoder().decode(bytes) }
	},
	'app.volume.writeText': async ({ vol, appId }, { path, text }) => {
		const full = privatePath(appId, path)
		const body = new TextEncoder().encode(requireString(text))
		await ensureParent(vol, full)
		await vol.writeFile(full, body)
		return null
	},
	'app.volume.readFile': async ({ vol, appId }, { path }) => {
		const bytes = await readBytes(vol, privatePath(appId, path))
		return { bytes: encodeBase64(bytes) }
	},
	'app.volume.writeFile': async ({ vol, appId }, { path, bytes }) => {
		const decoded = decodeBase64(bytes)
		const full = privatePath(appId, path)
		await ensureParent(vol, full)
		await vol.writeFile(full, decoded)
		return null
	}
}

export async function dispatchAppRpc(
	ctx: AppRpcContext,
	frame: { id: RequestId; method: string; params: unknown }
): Promise<AppRpcResponse> {
	const handler = (handlers as Record<string, Handler<AppRpcMethod>>)[frame.method]
	if (!handler) {
		return { jsonrpc: '2.0', id: frame.id, error: { ...APP_RPC_ERROR.methodNotFound } }
	}
	const params = (frame.params ?? {}) as AppRpcParams<AppRpcMethod>
	try {
		const result = await handler(ctx, params)
		return { jsonrpc: '2.0', id: frame.id, result }
	} catch (err) {
		if (err instanceof RpcError) {
			return { jsonrpc: '2.0', id: frame.id, error: err.payload }
		}
		return {
			jsonrpc: '2.0',
			id: frame.id,
			error: {
				code: APP_RPC_ERROR.internal.code,
				message: err instanceof Error ? err.message : APP_RPC_ERROR.internal.message
			}
		}
	}
}

// Stable response shape for "no app is mounted yet" — the supervisor sends
// this so the iframe sees a typed error instead of a hung promise.
export const noActiveAppResponse = (id: RequestId): AppRpcResponse => ({
	jsonrpc: '2.0',
	id,
	error: { ...APP_RPC_ERROR.noActiveApp }
})
