import type { AppRelay, ToolInvokeHandler } from '@justfiles/app'
import { HouseIcon } from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ToolResolveData = {
	result?: { callId: string; value: unknown }
	error?: { code: number; message: string }
}

type Ui = { url: string }

export function AppFrame(props: { id: string; ui: Ui; relay: AppRelay; onHome: () => void }) {
	const { id, ui, relay, onHome } = props
	const iframeRef = useRef<HTMLIFrameElement>(null)

	// Pending server-originated tool invocations awaiting the iframe response.
	const pendingToolInvokes = useRef(new Map<string, (data: ToolResolveData) => void>())
	// Iframe `onLoad` fires for the initial mount AND every reload. We use
	// the count to distinguish: > 1 means the iframe re-loaded (browser
	// refresh, navigation, or `location.reload()` from inside) so the
	// worker needs to drop the previous SDK instance's client tools.
	const loadCount = useRef(0)

	// Register tool invoke handler on the relay so server-originated tool calls
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
					relay.sendToolResult(callId, undefined, data.error)
				} else {
					relay.sendToolResult(callId, data.result?.value)
				}
			})
		}
		relay.onToolInvoke(handler)
		return () => relay.onToolInvoke(null)
	}, [relay])

	useEffect(() => {
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

			// Everything flows to the worker over WS. The dispatcher there
			// owns the typed registry; the chat layer just correlates by id.
			relay
				.sendRpc({ jsonrpc: '2.0', id: data.id, method: data.method, params: data.params })
				.then((reply) => {
					iframeRef.current?.contentWindow?.postMessage(reply, '*')
				})
		}

		window.addEventListener('message', receive)
		return () => window.removeEventListener('message', receive)
	}, [relay])

	// Fire `app.lifecycle` start once the iframe document is loaded — at that
	// point the SDK has installed its message listener, so a notification
	// posted now is guaranteed to land before any author code would
	// otherwise need to know we've started.
	const handleIframeLoad = () => {
		loadCount.current += 1
		if (loadCount.current > 1) relay.notifyIframeReload()
		iframeRef.current?.contentWindow?.postMessage(
			{ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } },
			'*'
		)
	}

	// Best-effort stop on unmount. Posts before React removes the iframe
	// from the DOM so the SDK can fire `onStop` callbacks and clear tool
	// handlers before its window is destroyed.
	useEffect(() => {
		const iframe = iframeRef.current
		return () => {
			iframe?.contentWindow?.postMessage(
				{ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'stop' } },
				'*'
			)
		}
	}, [])

	return (
		<div className="relative h-full w-full">
			<iframe
				ref={iframeRef}
				title={id}
				allow="pointer-lock"
				sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock"
				src={ui.url}
				onLoad={handleIframeLoad}
				className={cn('h-full w-full border-0')}
			/>
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
