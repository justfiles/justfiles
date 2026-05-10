import { AppWindowIcon, BracketsCurlyIcon, HouseIcon, PrinterIcon } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AppAction, AppRpcSender, ToolInvokeHandler, ToolResultSender } from './chat/types'

type ToolResolveData = {
	result?: { callId: string; value: unknown }
	error?: { code: number; message: string }
}

type Ui = { url: string }

export function AppFrame(props: {
	id: string
	ui: Ui
	// LEGACY: state, onAction, and the app.ready/app.action/app.state paths
	// below belong to the state-machine app bridge. Removed with #76.
	state: unknown
	onAction: (action: AppAction) => void
	onRpc: AppRpcSender
	onHome: () => void
	onRegisterToolInvoke: (handler: ToolInvokeHandler | null) => void
	onToolResult: ToolResultSender
}) {
	const { id, ui, state, onAction, onRpc, onHome, onRegisterToolInvoke, onToolResult } = props
	const [view, setView] = useState<'app' | 'state'>('app')
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const stateJson = useMemo(() => JSON.stringify(state ?? null, null, 2), [state])

	// LEGACY (state-machine): latest state goes to a ref so the RPC handler
	// can respond to a late `app.ready` with the current value without
	// re-binding listeners.
	const stateRef = useRef<unknown>(state)
	stateRef.current = state

	// Pending server-originated tool invocations awaiting the iframe response.
	const pendingToolInvokes = useRef(new Map<string, (data: ToolResolveData) => void>())

	// LEGACY (state-machine): broadcast new state to the iframe via the
	// `app.state` notification consumed by `client.js`.
	useEffect(() => {
		iframeRef.current?.contentWindow?.postMessage(
			{ jsonrpc: '2.0', method: 'app.state', params: { state } },
			'*'
		)
	}, [state])

	// Register tool invoke handler with useChat so server-originated tool calls
	// are routed to the iframe. The handler posts the request to the iframe and
	// resolves via `pendingToolInvokes` when the iframe responds.
	useEffect(() => {
		const handler: ToolInvokeHandler = (callId, name, input) => {
			iframeRef.current?.contentWindow?.postMessage(
				{ jsonrpc: '2.0', id: callId, method: 'app.tool.invoke', params: { callId, name, input } },
				'*'
			)
			pendingToolInvokes.current.set(callId, (data) => {
				if (data.error) {
					onToolResult(callId, undefined, data.error)
				} else {
					onToolResult(callId, data.result?.value)
				}
			})
		}
		onRegisterToolInvoke(handler)
		return () => onRegisterToolInvoke(null)
	}, [onRegisterToolInvoke, onToolResult])

	useEffect(() => {
		const respond = (rpcId: string | number, result: unknown) => {
			iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id: rpcId, result }, '*')
		}
		const reject = (rpcId: string | number, code: number, message: string) => {
			iframeRef.current?.contentWindow?.postMessage(
				{ jsonrpc: '2.0', id: rpcId, error: { code, message } },
				'*'
			)
		}
		const receive = (event: MessageEvent) => {
			if (event.source !== iframeRef.current?.contentWindow) return
			const data = event.data
			if (!data || data.jsonrpc !== '2.0') return

			// Handle tool invocation responses from the iframe (have id but no method).
			if (
				'id' in data &&
				typeof data.method === 'undefined' &&
				('result' in data || 'error' in data)
			) {
				const resolver = pendingToolInvokes.current.get(String(data.id))
				if (resolver) {
					pendingToolInvokes.current.delete(String(data.id))
					resolver(data as ToolResolveData)
					return
				}
			}

			if (!('id' in data) || typeof data.method !== 'string') {
				return
			}

			// LEGACY (state-machine, removed with #76): `app.ready`/`app.action`
			// are the legacy bridge methods served by `client.js`. Client-only
			// apps using `sdk.ts` never send these.
			if (data.method === 'app.ready') {
				respond(data.id, { state: stateRef.current })
				return
			}
			if (data.method === 'app.action') {
				const action = data.params?.action
				if (!action || typeof action.type !== 'string') {
					reject(data.id, -32602, 'Invalid app action.')
					return
				}
				onAction(action)
				respond(data.id, { ok: true })
				return
			}
			// Everything else flows to the worker over WS. The dispatcher there
			// owns the typed registry; the chat layer just correlates by id.
			onRpc({ jsonrpc: '2.0', id: data.id, method: data.method, params: data.params }).then(
				(reply) => {
					iframeRef.current?.contentWindow?.postMessage(reply, '*')
				}
			)
		}

		window.addEventListener('message', receive)
		return () => window.removeEventListener('message', receive)
	}, [onAction, onRpc])

	// LEGACY (state-machine): `app.print` is consumed by `client.js`.
	// Removed with #76.
	const printApp = () => {
		iframeRef.current?.contentWindow?.postMessage(
			{ jsonrpc: '2.0', method: 'app.print', params: {} },
			'*'
		)
	}

	// Fire `app.lifecycle` start once the iframe document is loaded — at that
	// point client-only apps' SDK has installed its message listener, so a
	// notification posted now is guaranteed to land before any author code
	// would otherwise need to know we've started.
	const handleIframeLoad = () => {
		iframeRef.current?.contentWindow?.postMessage(
			{ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } },
			'*'
		)
	}

	return (
		<div className="relative h-full w-full">
			<iframe
				ref={iframeRef}
				title={id}
				allow="pointer-lock"
				sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock"
				src={ui.url}
				onLoad={handleIframeLoad}
				className={cn('h-full w-full border-0', view === 'state' && 'hidden')}
			/>
			{view === 'state' ? (
				<pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-sky-50">
					{stateJson}
				</pre>
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
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className={cn(
						'text-sky-100 hover:bg-slate-900',
						view === 'app' && 'bg-sky-300 text-slate-950 hover:bg-sky-200'
					)}
					aria-label="Show app UI"
					aria-pressed={view === 'app'}
					title="Show app UI"
					onClick={() => setView('app')}
				>
					<AppWindowIcon />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className={cn(
						'text-sky-100 hover:bg-slate-900',
						view === 'state' && 'bg-sky-300 text-slate-950 hover:bg-sky-200'
					)}
					aria-label="Show state JSON"
					aria-pressed={view === 'state'}
					title="Show state JSON"
					onClick={() => setView('state')}
				>
					<BracketsCurlyIcon />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="text-sky-100 hover:bg-slate-900"
					aria-label="Print app"
					title="Print app"
					onClick={printApp}
				>
					<PrinterIcon />
				</Button>
			</div>
		</div>
	)
}
