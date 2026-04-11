import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import "./App.css";

type ConnectionState = "connecting" | "ready" | "disconnected";

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	toolCalls?: ToolCallInfo[];
}

interface ToolCallInfo {
	id: string;
	name: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
	status: "running" | "done";
}

interface AgentEvent {
	type: string;
	message?: {
		role: string;
	};
	assistantMessageEvent?: {
		type: string;
		delta?: string;
	};
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
}

function App() {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [connectionState, setConnectionState] =
		useState<ConnectionState>("disconnected");
	const [isStreaming, setIsStreaming] = useState(false);
	const [connectKey, setConnectKey] = useState(0);

	const wsRef = useRef<WebSocket | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const currentAssistantIdRef = useRef<string | null>(null);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	useEffect(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

		setConnectionState("connecting");
		wsRef.current = ws;

		ws.onmessage = (event) => {
			const data = JSON.parse(event.data);

			if (data.type === "ready") {
				setConnectionState("ready");
				return;
			}

			if (data.type === "error") {
				console.error("Server error:", data.message);
				setIsStreaming(false);
				return;
			}

			if (data.type === "event") {
				handleAgentEvent(data.event);
			}
		};

		ws.onclose = () => {
			if (wsRef.current === ws) {
				setConnectionState("disconnected");
				setIsStreaming(false);
				wsRef.current = null;
			}
		};

		ws.onerror = () => {
			if (wsRef.current === ws) {
				setConnectionState("disconnected");
				setIsStreaming(false);
			}
		};

		return () => {
			ws.close();
		};
	}, [connectKey]);

	const handleAgentEvent = (event: AgentEvent) => {
		switch (event.type) {
			case "agent_start":
				setIsStreaming(true);
				break;

			case "agent_end":
				setIsStreaming(false);
				currentAssistantIdRef.current = null;
				break;

			case "message_start": {
				if (event.message?.role === "assistant") {
					const id = crypto.randomUUID();
					currentAssistantIdRef.current = id;
					setMessages((prev) => [
						...prev,
						{ id, role: "assistant", content: "", toolCalls: [] },
					]);
				}
				break;
			}

			case "message_update": {
				const ame = event.assistantMessageEvent;
				if (ame?.type === "text_delta" && ame.delta) {
					const currentId = currentAssistantIdRef.current;
					if (!currentId) break;
					setMessages((prev) =>
						prev.map((m) =>
							m.id === currentId
								? { ...m, content: m.content + ame.delta }
								: m,
						),
					);
				}
				break;
			}

			case "tool_execution_start": {
				const currentId = currentAssistantIdRef.current;
				if (!currentId) break;
				setMessages((prev) =>
					prev.map((m) =>
						m.id === currentId
							? {
									...m,
									toolCalls: [
										...(m.toolCalls ?? []),
										{
											id: event.toolCallId!,
											name: event.toolName!,
											args: event.args,
											status: "running" as const,
										},
									],
								}
							: m,
					),
				);
				break;
			}

			case "tool_execution_end": {
				const currentId = currentAssistantIdRef.current;
				if (!currentId) break;
				setMessages((prev) =>
					prev.map((m) =>
						m.id === currentId
							? {
									...m,
									toolCalls: m.toolCalls?.map((tc) =>
										tc.id === event.toolCallId
											? {
													...tc,
													result: event.result,
													isError: event.isError,
													status: "done" as const,
												}
											: tc,
									),
								}
							: m,
					),
				);
				break;
			}
		}
	};

	const sendMessage = (e: FormEvent) => {
		e.preventDefault();
		const text = input.trim();
		if (!text || !wsRef.current || connectionState !== "ready") return;

		const userMsg: ChatMessage = {
			id: crypto.randomUUID(),
			role: "user",
			content: text,
		};

		setMessages((prev) => [...prev, userMsg]);
		setInput("");

		wsRef.current.send(JSON.stringify({ type: "prompt", text }));

		inputRef.current?.focus();
	};

	const handleAbort = () => {
		wsRef.current?.send(JSON.stringify({ type: "abort" }));
	};

	return (
		<div className="chat-container">
			<header className="chat-header">
				<h1>Frieren</h1>
				<span className={`status ${connectionState}`}>
					{connectionState}
				</span>
			</header>

			<div className="messages">
				{messages.length === 0 && (
					<div className="empty-state">
						<p>Send a message to start chatting.</p>
					</div>
				)}

				{messages.map((msg) => (
					<div key={msg.id} className={`message ${msg.role}`}>
						<div className="message-role">
							{msg.role === "user" ? "You" : "Frieren"}
						</div>
						<div className="message-content">
							{msg.content}
							{!msg.content && isStreaming && msg.role === "assistant" && (
								<span className="cursor" />
							)}
						</div>
						{msg.toolCalls && msg.toolCalls.length > 0 && (
							<div className="tool-calls">
								{msg.toolCalls.map((tc) => (
									<ToolCallBlock key={tc.id} toolCall={tc} />
								))}
							</div>
						)}
					</div>
				))}

				<div ref={messagesEndRef} />
			</div>

			<form className="input-area" onSubmit={sendMessage}>
				<textarea
					ref={inputRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							sendMessage(e);
						}
					}}
					placeholder={
						connectionState === "ready"
							? "Send a message... (Enter to send, Shift+Enter for newline)"
							: "Connecting..."
					}
					disabled={connectionState !== "ready"}
					rows={1}
				/>
				{isStreaming ? (
					<button type="button" onClick={handleAbort} className="abort-btn">
						Stop
					</button>
				) : (
					<button
						type="submit"
						disabled={!input.trim() || connectionState !== "ready"}
					>
						Send
					</button>
				)}
			</form>

			{connectionState === "disconnected" && (
				<button className="reconnect-btn" onClick={() => setConnectKey((k) => k + 1)}>
					Reconnect
				</button>
			)}
		</div>
	);
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className={`tool-call ${toolCall.status} ${toolCall.isError ? "error" : ""}`}>
			<button
				className="tool-call-header"
				onClick={() => setExpanded(!expanded)}
			>
				<span className="tool-call-indicator">
					{toolCall.status === "running" ? "..." : toolCall.isError ? "x" : "ok"}
				</span>
				<span className="tool-call-name">{toolCall.name}</span>
				<span className="tool-call-expand">{expanded ? "-" : "+"}</span>
			</button>
			{expanded && (
				<div className="tool-call-details">
					<div className="tool-call-section">
						<strong>Arguments:</strong>
						<pre>{JSON.stringify(toolCall.args, null, 2)}</pre>
					</div>
					{toolCall.result !== undefined && (
						<div className="tool-call-section">
							<strong>Result:</strong>
							<pre>{JSON.stringify(toolCall.result, null, 2)}</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export default App;
