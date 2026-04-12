import { DurableObject } from "cloudflare:workers";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { volume } from "@justfiles/fs";
import type { Volume } from "@justfiles/fs";
import { cfFsStorage, migrateCF } from "./db.do.ts";
import { createFrierenApiApp, type FrierenApiType } from './app.ts';
import { createFsTools } from "./tools.ts";
import { createSessionManager } from "./session/manager.ts";
import { createTranscriptWriter } from "./session/transcript.ts";
import type { SessionManager, TranscriptWriter, TranscriptLine } from "./session/types.ts";

interface ClientMessage {
	type: "prompt" | "abort";
	text?: string;
}

interface ServerMessage {
	type: "event" | "error" | "ready";
	event?: AgentEvent;
	message?: string;
}

const decoder = new TextDecoder();
const SOUL_PATH = '/soul.md';
const DEFAULT_SETUP_PROMPT = `You are a personal assistant and this is your first setup. Nothing has been set up yet.

Your first job is to set yourself up with the user. Tell the user that setup is incomplete and ask for the information you need to define who you are.

You should collect:
- the user's name
- the user's age
- who you are as the agent
- the character the user wants you to play
- a short description of the personality and tone the user prefers

Keep the setup conversational and concise. If some details are missing, ask follow-up questions until you have enough to define the assistant clearly.

Once you have enough information, write a complete future system prompt to ${SOUL_PATH} using the write tool. The file should contain the actual system prompt that future sessions will use, not a summary or notes.

Until ${SOUL_PATH} exists, prioritize setup. After the file has been written, follow the character and personality defined there in future sessions.`;

export class Frieren extends DurableObject<Env> {
	private agent: Agent | null = null;
	private agentPromise: Promise<Agent> | null = null;
	private readonly app: FrierenApiType;
	private readonly sessionManager: SessionManager;
	private readonly transcriptWriter: TranscriptWriter;
	private currentSessionId: string | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => migrateCF(ctx.storage));
		const namespace = ctx.id.toString();
		const fs = cfFsStorage(ctx.storage, namespace);
		this.app = createFrierenApiApp({ fs });

		const vol = volume(fs);
		this.transcriptWriter = createTranscriptWriter(vol);
		const placeholderGenerate = async () => 'placeholder';
		this.sessionManager = createSessionManager(vol, this.transcriptWriter, placeholderGenerate);
	}

	private async getOrCreateAgent(): Promise<Agent> {
		if (this.agent) return this.agent;
		if (this.agentPromise) return this.agentPromise;

		this.agentPromise = this.createAgent();
		try {
			this.agent = await this.agentPromise;
			return this.agent;
		} finally {
			this.agentPromise = null;
		}
	}

	private async createAgent(): Promise<Agent> {
		const model = getModel("openai", "gpt-4.1-mini");
		const namespace = this.ctx.id.toString();
		const storage = cfFsStorage(this.ctx.storage, namespace);
		const vol = volume(storage);
		const systemPrompt = await this.readSystemPrompt(vol);
		const tools = createFsTools(vol);

		const agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				tools,
			},
			convertToLlm: (messages: AgentMessage[]): Message[] => {
				return messages.filter(
					(m): m is Message =>
						"role" in m &&
						(m.role === "user" ||
							m.role === "assistant" ||
							m.role === "toolResult"),
				);
			},
			getApiKey: () => this.env.OPENAI_API_KEY,
			streamFn: (model, context, options) => {
				return streamSimple(model, context, {
					...options,
					apiKey: this.env.OPENAI_API_KEY,
				});
			},
		});

		return agent;
	}

	private async readSystemPrompt(vol: Volume): Promise<string> {
		if (!(await vol.exists(SOUL_PATH))) {
			return DEFAULT_SETUP_PROMPT;
		}

		const systemPrompt = decoder.decode(await vol.readFile(SOUL_PATH)).trim();
		return systemPrompt.length > 0 ? systemPrompt : DEFAULT_SETUP_PROMPT;
	}

	// ── Transcript extraction ────────────────────────────────────────────

	private extractTranscriptLines(messages: AgentMessage[]): TranscriptLine[] {
		const lines: TranscriptLine[] = [];
		const now = new Date().toISOString();
		for (const msg of messages) {
			if (!('role' in msg)) continue;
			const m = msg as Message;
			if (m.role === 'user') {
				const text = typeof m.content === 'string'
					? m.content
					: Array.isArray(m.content)
						? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
						: '';
				lines.push({ ts: now, role: 'user', content: text });
			} else if (m.role === 'assistant') {
				const am = m as any;
				let text = '';
				if (Array.isArray(am.content)) {
					for (const block of am.content) {
						if (block.type === 'text') text += block.text;
						if (block.type === 'toolCall') {
							lines.push({
								ts: now,
								role: 'tool_call',
								tool_name: block.name,
								input: block.args ?? {},
							});
						}
					}
				}
				if (text) {
					lines.push({ ts: now, role: 'assistant', content: text });
				}
			} else if (m.role === 'toolResult') {
				const tr = m as any;
				lines.push({
					ts: now,
					role: 'tool_result',
					tool_name: tr.name ?? 'unknown',
					content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
				});
			}
		}
		return lines;
	}

	// ── WebSocket handlers ────────────────────────────────────────────────

	async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		if (typeof message !== "string") return;

		let parsed: ClientMessage;
		try {
			parsed = JSON.parse(message);
		} catch {
			ws.send(
				JSON.stringify({
					type: "error",
					message: "Invalid JSON",
				} satisfies ServerMessage),
			);
			return;
		}

		if (parsed.type === "abort") {
			this.agent?.abort();
			return;
		}

		if (parsed.type === "prompt" && parsed.text) {
			// Handle /new command
			if (parsed.text.trim() === '/new') {
				try {
					const current = await this.sessionManager.getCurrent();
					if (current?.current_session_id) {
						await this.sessionManager.close(current.current_session_id);
						this.currentSessionId = await this.sessionManager.startNew();
						this.agent = null;
						this.agentPromise = null;
					}
					ws.send(JSON.stringify({
						type: "event",
						message: current?.current_session_id
							? "Session closed. Starting fresh."
							: "No active session to close.",
					} satisfies ServerMessage));
				} catch (err) {
					ws.send(JSON.stringify({
						type: "error",
						message: err instanceof Error ? err.message : "Unknown error",
					} satisfies ServerMessage));
				}
				return;
			}

			try {
				// Resolve session before prompting
				const result = await this.sessionManager.resolve();
				if (result.action === 'close_and_start') {
					await this.sessionManager.close(result.old_session_id);
					this.currentSessionId = await this.sessionManager.startNew();
				} else if (result.action === 'start_new') {
					this.currentSessionId = await this.sessionManager.startNew();
				} else {
					this.currentSessionId = result.session_id;
				}

				const agent = await this.getOrCreateAgent();
				const messageCountBefore = agent.state.messages.length;
				const unsubscribe = agent.subscribe(
					(event: AgentEvent, _signal: AbortSignal) => {
						ws.send(
							JSON.stringify({
								type: "event",
								event,
							} satisfies ServerMessage),
						);
					},
				);

				try {
					await agent.prompt(parsed.text);

					// Record transcript and touch session
					if (this.currentSessionId) {
						const newMessages = agent.state.messages.slice(messageCountBefore);
						const lines = this.extractTranscriptLines(newMessages);
						if (lines.length > 0) {
							await this.transcriptWriter.append(this.currentSessionId, lines);
						}
						await this.sessionManager.touch(this.currentSessionId);
					}
				} finally {
					unsubscribe();
				}
			} catch (err) {
				ws.send(
					JSON.stringify({
						type: "error",
						message:
							err instanceof Error ? err.message : "Unknown error",
					} satisfies ServerMessage),
				);
			}
		}
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		_reason: string,
		_wasClean: boolean,
	): Promise<void> {
		ws.close(code, "Durable Object is closing WebSocket");
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		ws.close(1011, "WebSocket error");
	}

	async fetch(request: Request): Promise<Response> {
		// Handle WebSocket upgrade
		const upgradeHeader = request.headers.get("Upgrade");
		if (upgradeHeader === "websocket") {
			// Treat each WebSocket connection as a fresh chat session so /soul.md is re-read.
			this.agent = null;
			this.agentPromise = null;

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			this.ctx.acceptWebSocket(server);

			// Send ready signal
			server.send(
				JSON.stringify({ type: "ready" } satisfies ServerMessage),
			);

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

		return this.app.fetch(request);
	}
}
