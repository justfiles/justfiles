import {
	type Capabilities,
	type Capability,
	type CapabilityCall,
	CapabilityError,
	capabilityRegistry,
	implementCapability,
	proxyCapabilitiesRpc,
	wsFeedTransport
} from '@justfiles/app/capabilities'
import { devkitCapability as makeDevkit } from '@justfiles/app/capabilities/devkit/host'
import type { Channel } from '@justfiles/app/capabilities/notify'
import { notifyHost } from '@justfiles/app/capabilities/notify/host'
import { type ReaderCapability, reader } from '@justfiles/app/capabilities/reader'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import type { Kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import { capsWsProtocols } from '../../shared/caps-ws.ts'
import { DEVKIT_ALLOWLIST } from '../../shared/devkit.allowlist.ts'
import { notificationStore } from '../notifications/store.ts'
import {
	frierenCompile,
	frierenImports,
	frierenRunner,
	frierenTypecheck,
	resetDevkitWorker
} from './devkit.client.ts'

type GetToken = () => Promise<string | null>

// App notifications run entirely in the browser: `notifyHost` stamps `source =
// appId` (kernel-trusted, unspoofable), then this channel writes straight to the
// one notification store — no DO round-trip, so it works offline. A click defaults
// to opening the app that emitted it; an explicit route from the app still wins.
const browserNotifyChannel: Channel = (notification) =>
	notificationStore.notify({
		...notification,
		route: notification.route ?? { kind: 'app', id: notification.source }
	})

export function clientCapabilities(
	fs: Volume,
	getToken: GetToken
): (kernel: Kernel) => Capabilities {
	const fallback = networkFallback(getToken)
	return capabilityRegistry(
		{
			volume: volumeCapability(fs, { systemAllowlist: ['justfiles.files'] }),
			reader: browserReader(fallback),
			notify: notifyHost(browserNotifyChannel),
			devkit: (kernel) => devkitCapability(fs, getToken, kernel)
		},
		{ fallback }
	)
}

function browserReader(remote: Capabilities): Capability {
	return implementCapability(reader, {
		read: (ctx, input) =>
			remote.invoke({
				appId: ctx.appId,
				capability: 'reader',
				method: 'read',
				args: [input],
				scopes: ctx.scopes,
				...(ctx.actor ? { actor: ctx.actor } : {})
			}) as ReturnType<ReaderCapability['read']>,
		open: (_ctx, { url }) => {
			let target: URL
			try {
				target = new URL(url)
			} catch {
				throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'reader', 'open')
			}
			if (target.protocol !== 'http:' && target.protocol !== 'https:')
				throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'reader', 'open')
			window.open(target.href, '_blank', 'noopener,noreferrer')
		}
	})
}

// devkit runs locally (it compiles + mounts on this thread, never the server) and
// is grant-gated: only allowlisted apps may reach the impl. The shared factory is
// built eagerly — its runner closures are cheap and the esbuild-wasm backend stays
// lazy inside `frierenCompile` — so a session that never opens devkit still pays
// nothing.
function devkitCapability(fs: Volume, getToken: GetToken, kernel: Kernel): Capability {
	const reject = (method: string): Promise<never> =>
		Promise.reject(new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', method))
	const impl = makeDevkit({
		fs,
		kernel,
		compile: frierenCompile,
		typecheck: frierenTypecheck,
		imports: frierenImports,
		runner: frierenRunner(fs, getToken)
	})
	return {
		invoke: async (call) => {
			if (!DEVKIT_ALLOWLIST.has(call.appId)) return reject(call.method)
			return impl.invoke(call)
		},
		subscribe: (call) => reject(call.method)
	}
}

// Everything not served locally proxies to the server over ONE shared, authed
// `_caps` Cap'n Web session. The OFFLINE guard fails fast before touching a socket
// that can't open; each call resolves the shared connection (opened lazily, reused).
function networkFallback(getToken: GetToken): Capabilities {
	const guard = (call: CapabilityCall): void => {
		if (typeof navigator !== 'undefined' && !navigator.onLine)
			throw new CapabilityError('CAPABILITY_OFFLINE', call.capability, call.method)
	}
	return {
		invoke: async (call) => {
			guard(call)
			try {
				return await (await sharedSocket(getToken)).caps.invoke(call)
			} catch (error) {
				// A hibernating DO force-closes the shared socket to reconnect a clean
				// Cap'n Web session, dropping the in-flight frame — the settings app's
				// first mutation after an idle window. The close handler clears `shared`,
				// so a cleared singleton means the socket broke: reconnect and retry once.
				// A still-live socket means a genuine capability error — rethrow it.
				// A lost reply can follow completed agent work; replay would repeat its effects.
				if (shared || (call.capability === 'ai' && call.method === 'runAgent')) throw error
				guard(call)
				return (await sharedSocket(getToken)).caps.invoke(call)
			}
		},
		subscribe: async (call, emit) => {
			guard(call)
			return (await sharedSocket(getToken)).caps.subscribe(call, emit)
		}
	}
}

// Drop session-owned capability resources on sign-out or user switch.
export function resetCapabilitySocket(): void {
	resetDevkitWorker()
	const ws = sharedWs
	const conn = shared
	sharedWs = undefined
	shared = undefined
	void conn?.then((c) => c.dispose()).catch(() => {})
	ws?.close()
}

// One authed `_caps` Cap'n Web session per session, shared by every proxied
// capability call and the server's `dirty` pushes. Lazy + self-healing: a broken
// session or a socket close clears the singleton so the next open makes a fresh one.
let shared: Promise<CapsConn> | undefined
let sharedWs: WebSocket | undefined

interface CapsConn {
	caps: Capabilities
	dispose(): void
}

function sharedSocket(getToken: GetToken): Promise<CapsConn> {
	// A server-side close (DO hibernation forces a fresh session) can leave the
	// cache pointing at a socket that is already CLOSING/CLOSED before its `close`
	// event self-heals the singleton. Drop it here so the next call reconnects
	// rather than `send`-ing on a dead socket ("WebSocket is already in CLOSING or
	// CLOSED state").
	if (sharedWs && sharedWs.readyState > WebSocket.OPEN) {
		shared = undefined
		sharedWs = undefined
	}
	if (!shared) {
		shared = openConn(getToken).catch((error) => {
			shared = undefined
			throw error
		})
	}
	return shared
}

async function openConn(getToken: GetToken): Promise<CapsConn> {
	const ws = await openAuthedWs(getToken)
	const proxy = capsProxyOverSocket(ws)
	// A broken session or a socket close drops the singleton so the next call
	// reopens against a fresh connection.
	const clear = () => {
		if (sharedWs === ws) {
			sharedWs = undefined
			shared = undefined
		}
	}
	proxy.onBroken(clear)
	ws.addEventListener('close', clear)
	return { caps: proxy.caps, dispose: () => proxy.dispose() }
}

// Wire a browser WebSocket into the caps proxy: push-based `message` events feed
// the pull-based transport. A close or error aborts the transport so in-flight
// calls reject and the session breaks — `wsFeedTransport.receive()` never rejects
// on its own. The whole browser-side wire in one place — driven directly by the
// wire test. (Server->client volume pokes ride the session `/ws` socket, not this
// capability session.)
export function capsProxyOverSocket(ws: WebSocket) {
	const { transport, feed } = wsFeedTransport(ws)
	ws.addEventListener('message', (e) => feed(e.data as string))
	const abort = () =>
		transport.abort?.(new CapabilityError('CAPABILITY_OFFLINE', 'capabilities', 'connect'))
	ws.addEventListener('close', abort)
	ws.addEventListener('error', abort)
	return proxyCapabilitiesRpc(transport)
}

async function openAuthedWs(getToken: GetToken): Promise<WebSocket> {
	const token = await getToken()
	if (!token) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'capabilities', 'connect')
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	// The token rides a `bearer.<token>` WebSocket subprotocol, not the URL query
	// string: query-string credentials leak into proxy/access logs and browser
	// history in a way handshake header values do not. The server reads it back
	// from `Sec-WebSocket-Protocol` (see worker/index.ts `tokenWs`).
	const ws = new WebSocket(
		`${protocol}//${window.location.host}/api/apps/_caps/ws`,
		capsWsProtocols(token)
	)
	sharedWs = ws
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener('open', () => resolve(), { once: true })
		ws.addEventListener(
			'error',
			() => reject(new CapabilityError('CAPABILITY_UNAVAILABLE', 'capabilities', 'connect')),
			{ once: true }
		)
	})
	return ws
}
