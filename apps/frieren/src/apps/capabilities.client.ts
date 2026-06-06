import {
	type Capabilities,
	type Capability,
	type CapabilityCall,
	CapabilityError,
	type Channel,
	capabilityRegistry,
	proxyCapabilities
} from '@justfiles/app/capabilities'
import type { Volume } from '@justfiles/fs'
import { DEVKIT_ALLOWLIST } from '../../shared/devkit.allowlist.ts'
import { volumeCapability } from '../../shared/volume.capability.ts'
import { flushActiveVolume } from '../fs.ts'

type GetToken = () => Promise<string | null>

// The browser kernel's capability seam. `volume` and `devkit` run locally on this
// thread; everything else (ai/integrations) proxies to the server through the
// network fallback over ONE shared WebSocket. One wiring line replaces the old
// hand-written invoke/stream routers.
export function clientCapabilities(fs: Volume, getToken: GetToken): Capabilities {
	return capabilityRegistry(
		{ volume: volumeCapability(fs), devkit: devkitCapability(fs, getToken) },
		{ fallback: networkFallback(getToken) }
	)
}

// devkit runs locally (it compiles + mounts on this thread, never the server) and
// is grant-gated: only allowlisted apps may reach the impl. Its module — and the
// esbuild toolchain it pulls — is imported lazily on first use, so a session that
// never opens devkit pays nothing.
function devkitCapability(fs: Volume, getToken: GetToken): Capability {
	const reject = (method: string): Promise<never> =>
		Promise.reject(new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', method))
	return {
		invoke: async (call) => {
			if (!DEVKIT_ALLOWLIST.has(call.appId)) return reject(call.method)
			const { invokeDevkit } = await import('./devkit.capability.ts')
			return invokeDevkit(fs, getToken, call)
		},
		subscribe: (call) => reject(call.method)
	}
}

// Everything not served locally proxies to the server. The package proxy
// correlates calls by id over the shared `_caps` socket and self-heals on a drop.
// The OFFLINE guard fails fast before touching a socket that can't open. Network
// streams aren't proxied yet (slice 11 lights up volume.watch locally).
function networkFallback(getToken: GetToken): Capabilities {
	const proxy = proxyCapabilities(() => openChannel(getToken))
	const guard = (call: CapabilityCall): void => {
		if (typeof navigator !== 'undefined' && !navigator.onLine)
			throw new CapabilityError('CAPABILITY_OFFLINE', call.capability, call.method)
	}
	return {
		invoke: async (call) => {
			guard(call)
			return proxy.invoke(call)
		},
		subscribe: async (call, emit) => {
			guard(call)
			return proxy.subscribe(call, emit)
		}
	}
}

// Drop the shared socket — called on OS teardown (sign-out / user switch) so a
// previous session's connection doesn't leak into the next.
export function resetCapabilitySocket(): void {
	const ws = sharedWs
	sharedWs = undefined
	shared = undefined
	ws?.close()
}

// Eagerly open the shared caps socket — normally it is lazy (opened on the first
// network capability), but the server's `dirty` push must also reach volume-only
// apps (e.g. paint) whose open windows never invoke a network capability. The host
// calls this on app open. Idempotent; failures self-heal on the next call.
export function ensureCapabilitySocket(getToken: GetToken): void {
	void sharedSocket(getToken).catch(() => {})
}

// One authed `_caps` socket per session, shared by every proxied capability call
// and the server's `dirty` pulls. Lazy + self-healing: a drop clears the singleton
// so the next open (proxy reconnect or ensureCapabilitySocket) makes a fresh one.
let shared: Promise<WebSocket> | undefined
let sharedWs: WebSocket | undefined

function sharedSocket(getToken: GetToken): Promise<WebSocket> {
	if (!shared) {
		shared = openAuthedWs(getToken).catch((error) => {
			shared = undefined
			throw error
		})
	}
	return shared
}

async function openChannel(getToken: GetToken): Promise<Channel> {
	return wsChannel(await sharedSocket(getToken))
}

// The Channel adapter over a browser WebSocket — the whole transport the package
// proxy needs. Each `onMessage`/`onClose` is a separate listener, so the proxy's
// frame dispatch and the `dirty` handler (wired in openAuthedWs) coexist.
export function wsChannel(ws: WebSocket): Channel {
	return {
		send: (frame) => ws.send(frame),
		onMessage: (cb) => ws.addEventListener('message', (event) => cb(event.data as string)),
		onClose: (cb) => ws.addEventListener('close', () => cb())
	}
}

async function openAuthedWs(getToken: GetToken): Promise<WebSocket> {
	const token = await getToken()
	if (!token) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'capabilities', 'connect')
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	const ws = new WebSocket(
		`${protocol}//${window.location.host}/api/apps/_caps/ws?token=${encodeURIComponent(token)}`
	)
	sharedWs = ws
	// The server pushes {type:'dirty',appId} when the agent changed an app
	// server-side. The package proxy ignores these (no `t` field), so flush here.
	ws.addEventListener('message', (event) => {
		try {
			if ((JSON.parse(event.data as string) as { type?: string }).type === 'dirty')
				flushActiveVolume()
		} catch {}
	})
	ws.addEventListener('close', () => {
		if (sharedWs === ws) {
			sharedWs = undefined
			shared = undefined
		}
	})
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
