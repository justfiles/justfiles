import {
	type Capabilities,
	type Capability,
	type CapabilityCall,
	CapabilityError,
	capabilityRegistry,
	proxyCapabilitiesRpc,
	wsFeedTransport
} from '@justfiles/app/capabilities'
import { devkitCapability as makeDevkit } from '@justfiles/app/capabilities/devkit/host'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import type { Kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import { DEVKIT_ALLOWLIST } from '../../shared/devkit.allowlist.ts'
import { flushActiveVolume } from '../fs.ts'
import { frierenCompile, frierenRunner } from './devkit.client.ts'
import * as host from './host'

type GetToken = () => Promise<string | null>

// The browser kernel's capability seam. `volume` and `devkit` run locally on this
// thread; everything else (ai/integrations) proxies to the server through the
// network fallback over ONE shared WebSocket. Only `devkit` needs the kernel — a
// per-entry factory the kernel resolves with ITSELF, so it reads sysroots +
// installs into the exact kernel it lives in (no whole-map wrapper).
export function clientCapabilities(
	fs: Volume,
	getToken: GetToken
): (kernel: Kernel) => Capabilities {
	return capabilityRegistry(
		{
			volume: volumeCapability(fs, { systemAllowlist: ['app.frieren.files'] }),
			devkit: (kernel) => devkitCapability(fs, getToken, kernel)
		},
		{ fallback: networkFallback(getToken) }
	)
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
		runner: frierenRunner(fs, getToken),
		onInstalled: () => host.notifyCatalog()
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
			return (await sharedSocket(getToken)).caps.invoke(call)
		},
		subscribe: async (call, emit) => {
			guard(call)
			return (await sharedSocket(getToken)).caps.subscribe(call, emit)
		}
	}
}

// Drop the shared socket — called on OS teardown (sign-out / user switch) so a
// previous session's connection doesn't leak into the next.
export function resetCapabilitySocket(): void {
	const ws = sharedWs
	const conn = shared
	sharedWs = undefined
	shared = undefined
	void conn?.then((c) => c.dispose()).catch(() => {})
	ws?.close()
}

// Eagerly open the shared caps socket — normally it is lazy (opened on the first
// network capability), but the server's `dirty` push must also reach volume-only
// apps (e.g. paint) whose open windows never invoke a network capability. The host
// calls this on app open. Idempotent; failures self-heal on the next call.
export function ensureCapabilitySocket(getToken: GetToken): void {
	void sharedSocket(getToken).catch(() => {})
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
	const proxy = capsProxyOverSocket(ws, flushActiveVolume)
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
// the pull-based transport; the server's `dirty` push runs `onDirty`. A close or
// error aborts the transport so in-flight calls reject and the session breaks —
// `wsFeedTransport.receive()` never rejects on its own. The whole browser-side
// wire in one place — driven directly by the wire test.
export function capsProxyOverSocket(ws: WebSocket, onDirty: () => void) {
	const { transport, feed } = wsFeedTransport(ws)
	ws.addEventListener('message', (e) => feed(e.data as string))
	const abort = () =>
		transport.abort?.(new CapabilityError('CAPABILITY_OFFLINE', 'capabilities', 'connect'))
	ws.addEventListener('close', abort)
	ws.addEventListener('error', abort)
	return proxyCapabilitiesRpc(transport, { dirty: () => onDirty() })
}

async function openAuthedWs(getToken: GetToken): Promise<WebSocket> {
	const token = await getToken()
	if (!token) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'capabilities', 'connect')
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	const ws = new WebSocket(
		`${protocol}//${window.location.host}/api/apps/_caps/ws?token=${encodeURIComponent(token)}`
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
