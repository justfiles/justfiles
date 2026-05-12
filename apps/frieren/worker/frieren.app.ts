/// <reference types="@justfiles/app/virtual" />
//
// Host-side wiring for client-only apps. The build-time virtual module
// (emitted by `hostApps()` in vite.config.ts; see @justfiles/app/vite) gives
// us per-app manifests — small data the worker bundles. The bytes for
// HTML/JS/CSS/wasm/wad ship via Workers Static Assets under
// `/apps/<id>/<path>` and are streamed through `c.env.ASSETS` by the
// `/apps/*` route in `index.ts`.

import { registry } from 'virtual:@justfiles/apps'
import type {
	AppHost,
	AppPermission,
	AppRpcRequest,
	AppRpcResponse,
	RequestId
} from '@justfiles/app'
import type { CapabilityBridge } from '@justfiles/app/capabilities'
import sdkJs from '@justfiles/app/sdk?raw'
import type { Volume } from '@justfiles/fs'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type Type from 'typebox'
import { type ClientToolDescriptor, dispatchAppRpc, noActiveAppResponse } from './app-rpc'
import type { Runtime } from './frieren.runtime'

type RegistryManifest =
	ReturnType<typeof registry.get> extends infer T
		? T extends { manifest: infer M }
			? M
			: never
		: never

const isNewShape = (m: RegistryManifest): m is Extract<RegistryManifest, { id: string }> =>
	'id' in m && 'title' in m

export const listAppIds = (): string[] => [...registry.keys()]
export const listApps = (): {
	id: string
	name: string
	description: string
	iconUrl?: string
	kind: 'sandbox' | 'esm'
	manifestUrl?: string
	baseUrl?: string
}[] =>
	[...registry.entries()].map(([id, entry]) => {
		const m = entry.manifest
		if (isNewShape(m)) {
			return {
				id,
				name: m.title,
				description: '',
				iconUrl: m.icon ? `/apps/${id}/${m.icon}` : undefined,
				kind: 'esm' as const,
				manifestUrl: `/apps/${id}/manifest.json`,
				baseUrl: `/apps/${id}/`
			}
		}
		return {
			id,
			name: m.name,
			description: m.description ?? '',
			iconUrl: m.icon ? `/apps/${id}/${m.icon}` : undefined,
			kind: 'sandbox' as const
		}
	})
export const hasApp = (id: string): boolean => registry.has(id)
export const isEsmApp = (id: string): boolean => {
	const entry = registry.get(id)
	return !!entry && isNewShape(entry.manifest)
}
export const getEntryPath = (id: string): string | undefined => registry.get(id)?.manifest.entry
// Manifest-declared permissions for an app. Default-deny — an unknown id,
// a new-shape manifest (no permissions field yet), or a manifest without
// the field returns an empty list, which the RPC dispatcher gates volume
// calls against.
export const getAppPermissions = (id: string): readonly AppPermission[] => {
	const m = registry.get(id)?.manifest
	if (!m || isNewShape(m)) return []
	return m.permissions ?? []
}
export const SDK_JS = sdkJs

const APP_STORAGE_KEY = 'active_app'
const CLIENT_TOOLS_STORAGE_KEY = 'active_app_client_tools'
const CLOSE_COMMAND = '/close'

interface AppStorage {
	get<T>(key: string): Promise<T | undefined>
	put<T>(key: string, value: T): Promise<void>
	delete(key: string): Promise<boolean>
}
type Socket = Pick<WebSocket, 'send'>

type ClientMessage = {
	type: string
	id?: string
	frame?: { id: RequestId; method: string; params: unknown }
	callId?: string
	result?: unknown
	error?: unknown
}

type ServerMessage =
	| { type: 'app_open'; id: string; ui: { url: string } }
	| { type: 'app_close' }
	| { type: 'app_rpc'; frame: AppRpcResponse }
	| { type: 'app_tool_invoke'; callId: string; name: string; input: unknown }

interface ActiveAppRecord {
	id: string
	tools: AgentTool[]
	// ESM apps live in the host page and re-register their tools on every
	// mount; we skip persistence and the `app_open` broadcast for them.
	mode: 'sandbox' | 'esm'
}

interface PersistedApp {
	id: string
}

type PendingToolCall = {
	resolve: (value: unknown) => void
	reject: (reason: unknown) => void
}

export class FrierenAppHost implements AppHost {
	private activeApp?: ActiveAppRecord
	// Pending tool calls are scoped to the active app: only one app can be active,
	// and close/reload rejects every outstanding call before changing that app.
	private readonly pendingToolCalls = new Map<string, PendingToolCall>()

	constructor(
		private readonly deps: {
			storage: AppStorage
			volume: Volume
			websockets: () => Iterable<Socket>
			runtime: () => Runtime | undefined
			capabilityBridge: CapabilityBridge
			sendAgentPrompt: (text: string) => Promise<string>
			isApp?: (id: string) => boolean
		}
	) {}

	current(): { id: string } | undefined {
		return this.activeApp ? { id: this.activeApp.id } : undefined
	}

	async hydrate(): Promise<void> {
		if (this.activeApp) return
		const saved = await this.deps.storage.get<PersistedApp>(APP_STORAGE_KEY)
		if (!saved || !this.isApp(saved.id)) return
		// Only sandbox apps are persisted (ESM activations are page-local), so
		// hydration always restores in sandbox mode.
		await this.restoreActiveApp(saved.id, 'sandbox')
	}

	async launch(id: string): Promise<void> {
		if (!this.isApp(id)) return
		if (this.activeApp) await this.close()
		const mode: 'sandbox' | 'esm' = isEsmApp(id) ? 'esm' : 'sandbox'
		const active = await this.restoreActiveApp(id, mode)
		if (mode === 'sandbox') {
			await this.deps.storage.put<PersistedApp>(APP_STORAGE_KEY, { id })
			this.broadcast(this.openMessageFor(active.id))
		}
	}

	async close(): Promise<void> {
		if (!this.activeApp) return
		const { id, tools, mode } = this.activeApp
		this.deps.runtime()?.removeTools(tools)
		this.failPendingToolCalls()
		this.activeApp = undefined
		if (mode === 'sandbox') {
			await this.deleteStoredApp(id)
			this.broadcast({ type: 'app_close' })
		}
	}

	async rebind(): Promise<void> {
		const id =
			this.activeApp?.id ?? (await this.deps.storage.get<PersistedApp>(APP_STORAGE_KEY))?.id
		if (!id || !this.isApp(id)) return
		// Only sandbox apps are persisted, so rebind never restores an ESM app.
		await this.restoreActiveApp(id, 'sandbox')
	}

	async clear(): Promise<void> {
		const id =
			this.activeApp?.id ?? (await this.deps.storage.get<PersistedApp>(APP_STORAGE_KEY))?.id
		if (this.activeApp) this.deps.runtime()?.removeTools(this.activeApp.tools)
		this.failPendingToolCalls()
		this.activeApp = undefined
		if (id) await this.deleteStoredApp(id)
		else await this.deps.storage.delete(APP_STORAGE_KEY)
	}

	async dispatch(frame: AppRpcRequest): Promise<AppRpcResponse> {
		const active = this.current()
		if (!active) return noActiveAppResponse(frame.id)
		return dispatchAppRpc(
			{
				vol: this.deps.volume,
				appId: active.id,
				permissions: getAppPermissions(active.id),
				bridge: this.deps.capabilityBridge,
				sendAgentPrompt: this.deps.sendAgentPrompt,
				registerClientTool: (descriptor) => this.registerClientTool(descriptor)
			},
			frame
		)
	}

	async handleMessage(ws: WebSocket, parsed: ClientMessage): Promise<boolean> {
		if (parsed.type === 'app_close') {
			await this.close()
			return true
		}
		if (parsed.type === 'app_launch') {
			if (parsed.id) await this.launch(parsed.id)
			return true
		}
		if (parsed.type === 'app_iframe_reload') {
			await this.resetClientTools()
			return true
		}
		if (parsed.type === 'app_tool_result') {
			if (parsed.callId) this.handleToolResult(parsed.callId, parsed.result, parsed.error)
			return true
		}
		if (parsed.type === 'app_rpc') {
			if (parsed.frame) {
				const reply = await this.dispatch(parsed.frame as AppRpcRequest)
				ws.send(JSON.stringify({ type: 'app_rpc', frame: reply } satisfies ServerMessage))
			}
			return true
		}
		return false
	}

	async handlePromptCommand(trimmed: string): Promise<boolean> {
		if (trimmed === CLOSE_COMMAND) {
			await this.close()
			return true
		}
		if (!trimmed.startsWith('/')) return false
		const id = trimmed.slice(1)
		if (!this.isApp(id)) return false
		await this.launch(id)
		return true
	}

	async registerClientTool(descriptor: ClientToolDescriptor): Promise<void> {
		const active = this.activeApp
		if (!active) return
		const toolName = `${active.id}_client_${descriptor.name}`
		if (active.tools.some((tool) => tool.name === toolName)) return
		const tool = this.createClientProxyTool(descriptor, active.id)
		active.tools.push(tool)
		this.deps.runtime()?.addTools([tool])
		// ESM apps re-register their tools on every mount, so we skip the
		// persistence step. A persisted proxy would point at a client that
		// is no longer listening.
		if (active.mode === 'sandbox') await this.persistClientTool(active.id, descriptor)
	}

	private handleToolResult(callId: string, result: unknown, error?: unknown): void {
		const pending = this.pendingToolCalls.get(callId)
		if (!pending) return
		this.pendingToolCalls.delete(callId)
		if (error) pending.reject(error)
		else pending.resolve(result)
	}

	private async resetClientTools(): Promise<void> {
		const active = this.activeApp
		if (!active) return
		const prefix = `${active.id}_client_`
		const stripped = active.tools.filter((tool) => tool.name.startsWith(prefix))
		if (stripped.length > 0) {
			this.deps.runtime()?.removeTools(stripped)
			active.tools = active.tools.filter((tool) => !stripped.includes(tool))
		}
		this.failPendingToolCalls()
		await this.deps.storage.delete(`${CLIENT_TOOLS_STORAGE_KEY}:${active.id}`)
	}

	openMessage(): ServerMessage | undefined {
		return this.activeApp ? this.openMessageFor(this.activeApp.id) : undefined
	}

	private async restoreActiveApp(id: string, mode: 'sandbox' | 'esm'): Promise<ActiveAppRecord> {
		const stored =
			mode === 'sandbox'
				? ((await this.deps.storage.get<ClientToolDescriptor[]>(
						`${CLIENT_TOOLS_STORAGE_KEY}:${id}`
					)) ?? [])
				: []
		const tools = stored.map((descriptor) => this.createClientProxyTool(descriptor, id))
		const active: ActiveAppRecord = { id, tools, mode }
		this.activeApp = active
		if (tools.length > 0) this.deps.runtime()?.addTools(tools)
		return active
	}

	private async persistClientTool(appId: string, descriptor: ClientToolDescriptor): Promise<void> {
		const key = `${CLIENT_TOOLS_STORAGE_KEY}:${appId}`
		const stored = (await this.deps.storage.get<ClientToolDescriptor[]>(key)) ?? []
		if (stored.some((value) => value.name === descriptor.name)) return
		await this.deps.storage.put(key, [...stored, descriptor])
	}

	private async deleteStoredApp(id: string): Promise<void> {
		await Promise.all([
			this.deps.storage.delete(APP_STORAGE_KEY),
			this.deps.storage.delete(`${CLIENT_TOOLS_STORAGE_KEY}:${id}`)
		])
	}

	private createClientProxyTool(descriptor: ClientToolDescriptor, appId: string): AgentTool {
		const schema = descriptor.schema as unknown as Type.TSchema
		const host = this
		const tool: AgentTool<typeof schema> = {
			name: `${appId}_client_${descriptor.name}`,
			label: `${appId}: ${descriptor.name}`,
			description: descriptor.description,
			parameters: schema,
			async execute(_id, input) {
				const callId = crypto.randomUUID()
				return await new Promise((resolve, reject) => {
					const timeout = setTimeout(() => {
						host.pendingToolCalls.delete(callId)
						reject({ code: -32021, message: 'tool_timeout' })
					}, 30_000)
					host.pendingToolCalls.set(callId, {
						resolve: (value) => {
							clearTimeout(timeout)
							resolve({
								content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
								details: value
							})
						},
						reject: (error) => {
							clearTimeout(timeout)
							reject(error)
						}
					})
					host.broadcast({ type: 'app_tool_invoke', callId, name: descriptor.name, input })
				})
			}
		}
		return tool as unknown as AgentTool
	}

	private openMessageFor(id: string): ServerMessage {
		return { type: 'app_open', id, ui: { url: `/apps/${id}/` } }
	}

	private broadcast(message: ServerMessage): void {
		const payload = JSON.stringify(message)
		for (const client of this.deps.websockets()) client.send(payload)
	}

	private failPendingToolCalls(): void {
		if (this.pendingToolCalls.size === 0) return
		const pending = Array.from(this.pendingToolCalls.values())
		this.pendingToolCalls.clear()
		for (const p of pending) p.reject({ code: -32020, message: 'tool_unavailable' })
	}

	private isApp(id: string): boolean {
		return this.deps.isApp?.(id) ?? hasApp(id)
	}
}
