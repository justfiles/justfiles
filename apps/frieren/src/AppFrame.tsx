import { PrinterIcon } from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import type { AppAction } from './chat/types'

type Ui = { url: string }

export function AppFrame(props: {
	id: string
	ui: Ui
	state: unknown
	onAction: (action: AppAction) => void
}) {
	const { id, ui, state, onAction } = props
	const iframeRef = useRef<HTMLIFrameElement>(null)

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
				className="h-full w-full border-0"
			/>
			<Button
				type="button"
				variant="outline"
				size="icon-sm"
				className="absolute right-2 top-2 z-10 border-sky-300 bg-slate-950/90 text-sky-100 shadow-[3px_3px_0_rgba(0,0,0,0.45)] hover:bg-slate-900"
				aria-label="Print app"
				title="Print app"
				onClick={printApp}
			>
				<PrinterIcon />
			</Button>
		</div>
	)
}
