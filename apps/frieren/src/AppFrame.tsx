import { AppWindowIcon, BracketsCurlyIcon, PrinterIcon } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AppAction } from './chat/types'

type Ui = { url: string }

export function AppFrame(props: {
	id: string
	ui: Ui
	state: unknown
	onAction: (action: AppAction) => void
}) {
	const { id, ui, state, onAction } = props
	const [view, setView] = useState<'app' | 'state'>('app')
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const stateJson = useMemo(() => JSON.stringify(state ?? null, null, 2), [state])

	// Latest state goes to a ref so the RPC handler can respond to a late
	// `app.ready` with the current value without re-binding listeners.
	const stateRef = useRef<unknown>(state)
	stateRef.current = state

	useEffect(() => {
		iframeRef.current?.contentWindow?.postMessage(
			{ jsonrpc: '2.0', method: 'app.state', params: { state } },
			'*'
		)
	}, [state])

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
			if (!data || data.jsonrpc !== '2.0' || !('id' in data) || typeof data.method !== 'string') {
				return
			}

			switch (data.method) {
				case 'app.ready':
					respond(data.id, { state: stateRef.current })
					break
				case 'app.action': {
					const action = data.params?.action
					if (!action || typeof action.type !== 'string') {
						reject(data.id, -32602, 'Invalid app action.')
						return
					}
					onAction(action)
					respond(data.id, { ok: true })
					break
				}
				default:
					reject(data.id, -32601, `Unknown method: ${data.method}`)
			}
		}

		window.addEventListener('message', receive)
		return () => window.removeEventListener('message', receive)
	}, [onAction])

	const printApp = () => {
		iframeRef.current?.contentWindow?.postMessage(
			{ jsonrpc: '2.0', method: 'app.print', params: {} },
			'*'
		)
	}

	return (
		<div className="relative h-full w-full">
			<iframe
				ref={iframeRef}
				title={id}
				sandbox="allow-scripts allow-forms allow-modals"
				src={ui.url}
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
