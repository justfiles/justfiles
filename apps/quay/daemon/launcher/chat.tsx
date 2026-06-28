import { Transcript } from '@justfiles/ui/Transcript'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useAgentChat } from './agentChat'

// The launcher's chat surface: a display-only transcript the native launcher embeds in a
// transparent WKWebView over its own AppKit chrome. The native composer owns input and
// drives this view through the `window.quay*` bridge; the view renders the shared
// <Transcript/> over the daemon's `/agent` RPC (via useAgentChat) and reports streaming +
// connection state back over `webkit.messageHandlers.status` (drives the native Stop
// button). Slash commands and abort are not on the daemon agent yet — their bridge entries
// are no-ops until that parity lands.

interface QuayChatWindow {
	webkit?: { messageHandlers?: { status?: { postMessage(message: unknown): void } } }
	quaySend?: (text: string) => void
	quayCommand?: (name: string) => void
	quayAbort?: () => void
}

const win = window as unknown as QuayChatWindow

function ChatApp() {
	const chat = useAgentChat()

	// Wire the native input bridge to the live chat hook. Enter in the native composer
	// calls quaySend; quayCommand/quayAbort stay no-ops until the daemon agent grows
	// slash-commands + abort (their own parity item), but are defined so the native
	// optional-chaining calls resolve.
	useEffect(() => {
		win.quaySend = (text) => void chat.send(String(text ?? ''))
		win.quayCommand = () => {}
		win.quayAbort = () => {}
		return () => {
			win.quaySend = undefined
			win.quayCommand = undefined
			win.quayAbort = undefined
		}
	}, [chat.send])

	// Mirror streaming + connection state to native.
	useEffect(() => {
		win.webkit?.messageHandlers?.status?.postMessage({
			isStreaming: chat.isStreaming,
			connectionState: chat.connection
		})
	}, [chat.isStreaming, chat.connection])

	// Picking a question option is just the next prompt — reuse the same send path.
	return (
		<Transcript
			messages={chat.messages}
			isStreaming={chat.isStreaming}
			onOption={(label) => void chat.send(label)}
		/>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<ChatApp />)
