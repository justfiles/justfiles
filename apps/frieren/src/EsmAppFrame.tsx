import { useAuth } from '@clerk/clerk-react'
import {
	type Agent,
	type AppHandle,
	type AppRelay,
	type AppRpcRequest,
	type Capabilities,
	createHost,
	createToolRegistry,
	loadApp,
	loadManifest,
	type ToolInvokeHandler,
	type ToolRegistryHandle
} from '@justfiles/app'
import { HouseIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { createFsVolume } from './fs'

// Capability brokers run in the worker; routing direct typed calls from
// the browser to those brokers is its own slice. Until that lands, expose
// a stub that throws so any accidental call surfaces clearly instead of
// silently resolving.
function stubCapabilities(): Capabilities {
	const reject = (capability: string, method: string) => () =>
		Promise.reject(new Error(`capability ${capability}.${method} not wired`))
	return {
		email: {
			listUnread: reject('email', 'listUnread'),
			readDetail: reject('email', 'readDetail'),
			markRead: reject('email', 'markRead')
		},
		calendar: {
			listToday: reject('calendar', 'listToday')
		}
	}
}

let rpcCounter = 0
const nextRpcId = () => `esm-${++rpcCounter}`

// Today's wiring reuses `AppRelay` (sandbox app JSON-RPC) to reach the
// worker for `agent.send` / `tool.register`. Per the cleanup notes on
// issue #123, this whole bridging block is meant to be deleted and
// replaced with a small ESM-native typed bridge.
export function EsmAppFrame(props: {
	id: string
	manifestUrl: string
	baseUrl: string
	relay: AppRelay
	onHome: () => void
}) {
	const { id, manifestUrl, baseUrl, relay, onHome } = props
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	const containerRef = useRef<HTMLDivElement>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const container = containerRef.current
		if (!container) return
		let cancelled = false
		let handle: AppHandle | undefined
		let toolRegistry: ToolRegistryHandle | undefined
		setError(null)

		const sendAgentPrompt = async (text: string): Promise<string> => {
			const frame: AppRpcRequest = {
				jsonrpc: '2.0',
				id: nextRpcId(),
				method: 'app.agent.send',
				params: { text }
			}
			const reply = await relay.sendRpc(frame)
			if (reply.error) throw new Error(reply.error.message)
			const result = reply.result as { text: string } | undefined
			return result?.text ?? ''
		}

		const registerWithWorker = async (tool: {
			name: string
			description: string
			schema: unknown
		}) => {
			const frame: AppRpcRequest = {
				jsonrpc: '2.0',
				id: nextRpcId(),
				method: 'app.tool.register',
				params: {
					name: tool.name,
					description: tool.description,
					schema: tool.schema as Record<string, unknown>
				}
			}
			const reply = await relay.sendRpc(frame)
			if (reply.error) throw new Error(reply.error.message)
		}

		const toolInvokeHandler: ToolInvokeHandler = (callId, name, input) => {
			void (async () => {
				if (!toolRegistry) {
					relay.sendToolResult(callId, undefined, { code: -32020, message: 'tool_unavailable' })
					return
				}
				try {
					const value = await toolRegistry.invoke(name, input)
					relay.sendToolResult(callId, value)
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e)
					relay.sendToolResult(callId, undefined, { code: -32022, message })
				}
			})()
		}

		;(async () => {
			try {
				const absoluteManifestUrl = new URL(manifestUrl, window.location.href).toString()
				const absoluteBaseUrl = new URL(baseUrl, window.location.href).toString()
				const manifest = await loadManifest({ url: absoluteManifestUrl })
				if (cancelled) return
				const backend = await createFsVolume(() => getTokenRef.current())
				if (cancelled) return

				const tools = createToolRegistry({
					onRegister: (tool) => {
						void registerWithWorker(tool).catch((err) => {
							console.error('failed to register tool with worker:', err)
						})
					}
				})
				toolRegistry = tools

				const agent: Agent = { send: sendAgentPrompt, tools: tools.registry }
				const host = createHost({
					appId: manifest.id,
					volume: backend,
					capabilities: stubCapabilities(),
					agent
				})

				relay.onToolInvoke(toolInvokeHandler)

				const loaded = await loadApp({
					manifest,
					baseUrl: absoluteBaseUrl,
					el: container,
					host
				})
				if (cancelled) {
					await loaded.unmount()
					return
				}
				handle = loaded
			} catch (e) {
				if (!cancelled) setError(String(e instanceof Error ? e.message : e))
			}
		})()
		return () => {
			cancelled = true
			relay.onToolInvoke(null)
			void handle?.unmount()
			toolRegistry?.dispose()
			if (container) container.innerHTML = ''
		}
	}, [manifestUrl, baseUrl, relay])

	return (
		<div className="relative h-full w-full">
			<div ref={containerRef} data-app-id={id} className="h-full w-full overflow-hidden" />
			{error ? (
				<div className="absolute inset-0 flex items-center justify-center bg-slate-950/95 p-6 text-center text-sm text-rose-200">
					Failed to load app: {error}
				</div>
			) : null}
			<div className="absolute right-2 top-2 z-10 flex border border-sky-300 bg-slate-950/90 shadow-[3px_3px_0_rgba(0,0,0,0.45)]">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="text-sky-100 hover:bg-slate-900"
					aria-label="Return home"
					title="Return home"
					onClick={onHome}
				>
					<HouseIcon />
				</Button>
			</div>
		</div>
	)
}
