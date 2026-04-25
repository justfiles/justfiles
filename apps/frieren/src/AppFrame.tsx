import { useEffect, useMemo, useRef } from 'react'
import { appClientScript } from '../apps/client'
import type { AppAction } from './chat/types'

type Ui = {
	entry: string
	assets: Record<string, string>
}

function safeScript(source: string): string {
	return source.replaceAll('</script', '<\\/script')
}

function pathKey(path: string): string {
	return path.replace(/^[./]+/, '').replace(/^\/+/, '')
}

function resolveLocalAssets(html: string, assets: Record<string, string>): string {
	const scripts: string[] = []
	const withScripts = html.replace(
		/<script\b([^>]*)\bsrc=(["'])(.*?)\2([^>]*)><\/script>/gi,
		(match, before: string, _quote: string, src: string, after: string) => {
			const script = assets[pathKey(src)]
			if (script === undefined) return match
			scripts.push(`<script${before}${after}>${safeScript(script)}</script>`)
			return ''
		}
	)

	const withStyles = withScripts.replace(
		/<link\b([^>]*)\bhref=(["'])(.*?)\2([^>]*)>/gi,
		(match, before: string, _quote: string, href: string, after: string) => {
			const css = assets[pathKey(href)]
			if (css === undefined || !/rel=(["'])stylesheet\1/i.test(`${before}${after}`)) return match
			return `<style>${css.replaceAll('</style', '<\\/style')}</style>`
		}
	)

	if (scripts.length === 0) return withStyles
	if (/<\/body>/i.test(withStyles))
		return withStyles.replace(/<\/body>/i, `${scripts.join('')}</body>`)
	return `${withStyles}${scripts.join('')}`
}

function injectHeadScript(html: string, script: string): string {
	const tag = `<script>${safeScript(script)}</script>`
	if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b([^>]*)>/i, `<head$1>${tag}`)
	return `${tag}${html}`
}

function buildSrcDoc(ui: Ui): string {
	const html = ui.assets[ui.entry] ?? ''
	return injectHeadScript(resolveLocalAssets(html, ui.assets), appClientScript)
}

export function AppFrame(props: {
	id: string
	ui: Ui
	state: unknown
	onAction: (action: AppAction) => void
}) {
	const { id, ui, state, onAction } = props
	const iframeRef = useRef<HTMLIFrameElement>(null)

	// Bundle-level memo: srcDoc changes only when the UI assets do, not on
	// every state dispatch.
	const srcDoc = useMemo(() => buildSrcDoc(ui), [ui])

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

	return (
		<iframe
			ref={iframeRef}
			title={id}
			sandbox="allow-scripts allow-forms"
			srcDoc={srcDoc}
			className="h-full w-full border-0"
		/>
	)
}
