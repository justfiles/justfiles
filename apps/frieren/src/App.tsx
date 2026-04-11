import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

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

const statusBadge: Record<ConnectionState, string> = {
	ready: "badge-success",
	connecting: "badge-warning",
	disconnected: "badge-error",
};

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
		<div className="flex flex-col h-screen max-w-3xl mx-auto w-full">
			<header className="navbar border-b border-base-300 px-4 min-h-12">
				<div className="flex-1">
					<span className="text-lg font-semibold">Frieren</span>
				</div>
				<div className="flex-none">
					<span className={`badge badge-sm ${statusBadge[connectionState]}`}>
						{connectionState}
					</span>
				</div>
			</header>

			<div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
				{messages.length === 0 && (
					<div className="flex items-center justify-center flex-1 text-base-content/40">
						<p>Send a message to start chatting.</p>
					</div>
				)}

				{messages.map((msg) => (
					<div
						key={msg.id}
						className={`chat ${msg.role === "user" ? "chat-end" : "chat-start"}`}
					>
						<div className="chat-header text-xs opacity-60 mb-1">
							{msg.role === "user" ? "You" : "Frieren"}
						</div>
						<div
							className={`chat-bubble whitespace-pre-wrap break-words ${
								msg.role === "user"
									? "chat-bubble-primary"
									: "chat-bubble-neutral"
							}`}
						>
							{msg.content}
							{!msg.content && isStreaming && msg.role === "assistant" && (
								<span className="inline-block w-0.5 h-[1em] bg-current animate-pulse align-text-bottom ml-px" />
							)}
						</div>
						{msg.toolCalls && msg.toolCalls.length > 0 && (
							<div className="chat-footer mt-2 flex flex-col gap-1.5 w-full">
								{msg.toolCalls.map((tc) => (
									<ToolCallBlock key={tc.id} toolCall={tc} />
								))}
							</div>
						)}
					</div>
				))}

				<div ref={messagesEndRef} />
			</div>

			<form
				className="flex gap-2 p-4 border-t border-base-300"
				onSubmit={sendMessage}
			>
				<textarea
					ref={inputRef}
					className="textarea textarea-bordered flex-1 resize-none min-h-10 max-h-32 leading-normal"
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
					<button
						type="button"
						className="btn btn-error btn-sm self-end"
						onClick={handleAbort}
					>
						Stop
					</button>
				) : (
					<button
						type="submit"
						className="btn btn-primary btn-sm self-end"
						disabled={!input.trim() || connectionState !== "ready"}
					>
						Send
					</button>
				)}
			</form>

			{connectionState === "disconnected" && (
				<div className="px-4 pb-4">
					<button
						className="btn btn-outline btn-block btn-sm"
						onClick={() => setConnectKey((k) => k + 1)}
					>
						Reconnect
					</button>
				</div>
			)}
		</div>
	);
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }) {
	const [expanded, setExpanded] = useState(false);

	const indicatorClass =
		toolCall.status === "running"
			? "text-warning"
			: toolCall.isError
				? "text-error"
				: "text-success";

	const indicatorLabel =
		toolCall.status === "running" ? "..." : toolCall.isError ? "x" : "ok";

	return (
		<div
			className={`collapse collapse-arrow border border-base-300 rounded-lg bg-base-200/50 ${
				toolCall.isError ? "border-error/30" : ""
			}`}
		>
			<input
				type="checkbox"
				checked={expanded}
				onChange={() => setExpanded(!expanded)}
			/>
			<div className="collapse-title flex items-center gap-2 text-sm min-h-0 py-2 px-3 after:!top-4">
				<span
					className={`font-mono text-xs badge badge-xs ${indicatorClass}`}
				>
					{indicatorLabel}
				</span>
				<span className="font-mono flex-1">{toolCall.name}</span>
			</div>
			<div className="collapse-content px-3 pb-3 text-sm">
				<div className="mb-2">
					<div className="text-xs uppercase tracking-wide opacity-50 mb-1 font-semibold">
						Arguments
					</div>
					<pre className="bg-base-300 rounded p-2 text-xs overflow-x-auto whitespace-pre-wrap break-all">
						{JSON.stringify(toolCall.args, null, 2)}
					</pre>
				</div>
				{toolCall.result !== undefined && (
					<div>
						<div className="text-xs uppercase tracking-wide opacity-50 mb-1 font-semibold">
							Result
						</div>
						<pre className="bg-base-300 rounded p-2 text-xs overflow-x-auto whitespace-pre-wrap break-all">
							{JSON.stringify(toolCall.result, null, 2)}
						</pre>
					</div>
				)}
			</div>
		</div>
	);
}

export default App;
