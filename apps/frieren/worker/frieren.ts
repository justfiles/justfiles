import { DurableObject } from "cloudflare:workers";
import { Agent } from "@mariozechner/pi-agent-core";
import { completeSimple, getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { Effect } from 'effect'
import { volume } from "@justfiles/fs";
import { cfFsStorage, migrateCF } from "./db.do.ts";
import { createFrierenApiApp, type FrierenApiType } from './app.ts';
import { createFsTools, createFetchTool, createSearchTool } from "./tools.ts";
import { windowMessages } from "./session/context.ts";
import { makeSessionRuntime } from './session/effect/live.ts'
import { closeSession, persistTurn, prepareTurn, startNewSession } from './session/effect/programs.ts'
import { SessionStore } from './session/effect/services.ts'
import type { TranscriptLine } from "./session/types.ts";

interface ClientMessage {
	type: "prompt" | "abort";
	text?: string;
}

interface ServerMessage {
	type: "event" | "error" | "ready";
	event?: AgentEvent;
	message?: string;
}

export class Frieren extends DurableObject<Env> {
	private agent: Agent | null = null;
	private agentPromise: Promise<Agent> | null = null;
	private readonly app: FrierenApiType;
	private readonly vol;
	private readonly sessionRuntime: ReturnType<typeof makeSessionRuntime>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => migrateCF(ctx.storage));
		const namespace = ctx.id.toString();
		const fs = cfFsStorage(ctx.storage, namespace);
		this.app = createFrierenApiApp({ fs });

		this.vol = volume(fs);
		const generateSessionText = this.createSessionTextGenerator();
		this.sessionRuntime = makeSessionRuntime(this.vol, generateSessionText);
	}

	private getBackendConfig() {
		const openaiModel = getModel("openai", "gpt-4.1-mini");

		// Local LM Studio backend — OpenAI-compatible /v1/chat/completions.
		// No real auth, but the OpenAI SDK requires a non-empty apiKey string.
		const localModel = {
			id: "google/gemma-4-e4b",
			name: "Gemma 4 (local)",
			api: "openai-completions",
			provider: "lm-studio",
			baseUrl: "http://127.0.0.1:1234/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		} as unknown as typeof openaiModel;

		const BACKEND: 'openai' | 'local' = 'local';
		const model = BACKEND === 'local' ? localModel : openaiModel;
		const apiKey = BACKEND === 'local' ? 'lm-studio' : this.env.OPENAI_API_KEY;

		return { model, apiKey };
	}

	private createSessionTextGenerator() {
		const { model, apiKey } = this.getBackendConfig();

		return async (systemPrompt: string, userPrompt: string) => {
			const response = await completeSimple(model, {
				systemPrompt,
				messages: [
					{
						role: 'user',
						content: userPrompt,
						timestamp: Date.now(),
					},
				],
			}, { apiKey });

			return this.extractAssistantText(response);
		};
	}

	private extractAssistantText(message: AssistantMessage): string {
		const text = message.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('')
			.trim();

		if (!text) {
			throw new Error('Session text generation returned no text content')
		}

		return text
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
		const { model, apiKey } = this.getBackendConfig();

		const tools = [...createFsTools(this.vol), createFetchTool(), createSearchTool()];

		const agent = new Agent({
			initialState: {
				systemPrompt: '', // set dynamically each turn in webSocketMessage
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
			getApiKey: () => apiKey,
			streamFn: (model, context, options) => {
				return streamSimple(model, context, {
					...options,
					apiKey,
				});
			},
		});

		// transformContext only sees messages — it cannot set systemPrompt,
		// because the Agent snapshots systemPrompt BEFORE transformContext runs.
		// Use it purely for context windowing.
		agent.transformContext = async (messages) => windowMessages(messages, 20);

		return agent;
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
					const current = await this.sessionRuntime.runPromise(
						Effect.flatMap(SessionStore, (store) => store.getCurrent()),
					);
					if (current?.current_session_id) {
						await this.sessionRuntime.runPromise(
							closeSession(current.current_session_id),
						);
						await this.sessionRuntime.runPromise(startNewSession());
						// Clear agent transcript — keep the agent alive
						if (this.agent) this.agent.state.messages = [];
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
				const prepared = await this.sessionRuntime.runPromise(prepareTurn());
				const sessionId = prepared.currentSessionId;

				const agent = await this.getOrCreateAgent();
				if (prepared.isNewSession && agent.state.messages.length > 0) {
					agent.state.messages = [];
				}

				// Set systemPrompt BEFORE prompt() — the Agent snapshots it by value
				// at the start of each turn, so mid-turn mutations (e.g. inside
				// transformContext) would be ignored for the current call.
				agent.state.systemPrompt = prepared.systemPrompt;

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
					if (sessionId) {
						const newMessages = agent.state.messages.slice(messageCountBefore);
						const lines = this.extractTranscriptLines(newMessages);
						await this.sessionRuntime.runPromise(
							persistTurn({
								sessionId,
								lines,
							}),
						);
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
			// Agent is long-lived — transformContext re-reads soul.md every turn,
			// so there is no need to recreate the agent on reconnect.
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
