import '@justfiles/design/design.css'
import '@justfiles/design/mac.css'
import { Transcript } from '@justfiles/ui/Transcript'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAgentChat } from './agentChat'
import { CommandOutput } from './CommandOutput'

// The launcher's chat surface: a display-only transcript the native launcher embeds in a
// transparent WKWebView over its own AppKit chrome. The view is a LIVE VIEW of the shared
// session (useAgentChat subscribes to /agent), so any turn — a typed prompt, or a `/skill`
// the daemon dispatched over /system — shows up here without the webview doing anything.
// The native composer owns input: `quaySend` sends a prompt; `quayShowOutput` renders a
// one-off command result (e.g. `/debug`) in place of the transcript. Streaming + connection
// state flow back over `webkit.messageHandlers.status` (drives the native Stop button).
// Commands are NOT handled here — the launcher dispatches them over /system.

interface QuayChatWindow {
	webkit?: { messageHandlers?: { status?: { postMessage(message: unknown): void } } }
	quaySend?: (text: string) => void
	quayAbort?: () => void
	quayShowOutput?: (body: string) => void
}

const win = window as unknown as QuayChatWindow

function ChatApp() {
	const chat = useAgentChat()
	// A command's one-off text output (e.g. `/debug`), pushed from native after a /system
	// dispatch. Shown in place of the transcript; cleared when the user sends a message.
	const [output, setOutput] = useState<string | null>(null)

	// Wire the native input bridge to the live chat hook. `quaySend` sends a prompt (and
	// drops any command output); `quayAbort` (the native Stop button) cancels the in-flight
	// turn; `quayShowOutput` shows a command's text result.
	useEffect(() => {
		win.quaySend = (text) => {
			setOutput(null)
			chat.send(String(text ?? ''))
		}
		win.quayAbort = () => chat.abort()
		win.quayShowOutput = (body) => setOutput(String(body ?? ''))
		return () => {
			win.quaySend = undefined
			win.quayAbort = undefined
			win.quayShowOutput = undefined
		}
	}, [chat.send, chat.abort])

	// Mirror streaming + connection state to native.
	useEffect(() => {
		win.webkit?.messageHandlers?.status?.postMessage({
			isStreaming: chat.isStreaming,
			connectionState: chat.connection
		})
	}, [chat.isStreaming, chat.connection])

	// A command's text output shows in place of the transcript; otherwise render the live
	// transcript. A turn error (classified by the daemon — e.g. auth-expired) rides in as a
	// trailing error block so the native surface surfaces it instead of dropping it. Picking a
	// question option is just the next prompt (which clears output).
	if (output != null) return <CommandOutput body={output} />
	const messages = chat.error
		? [
				...chat.messages,
				{ id: 'agent-error', role: 'assistant' as const, content: chat.error, error: true as const }
			]
		: chat.messages
	return (
		<Transcript
			messages={messages}
			isStreaming={chat.isStreaming}
			onOption={(label) => void chat.send(label)}
		/>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<ChatApp />)
