import { DurableObject } from "cloudflare:workers";
import { Agent } from "@mariozechner/pi-agent-core";
import { completeSimple, getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { volume } from "@justfiles/fs";
import { cfFsStorage, migrateCF } from "./db.do.ts";
import { createFrierenApiApp, type FrierenApiType } from './app.ts';
import { createFsTools, createFetchTool, createSearchTool } from "./tools.ts";
import { windowMessages } from "./session/context.ts";
import { makeSessionRuntime } from './session/effect/live.ts'
import { loadRecentHistory, loadRehydrationMessages, maybeUpdateRollingSummary, persistTurn, prepareTurn, type DisplayMessage, type RehydrationLine } from './session/effect/programs.ts'
import type { TranscriptLine } from "./session/types.ts";

interface ClientMessage {
	type: "prompt" | "abort";
	text?: string;
}

interface ServerMessage {
	type: "event" | "error" | "ready" | "history";
	event?: AgentEvent;
	message?: string;
	messages?: ReadonlyArray<DisplayMessage>;
}

const FINAL_ANSWER_ONLY_INSTRUCTION =
	'When you answer the user, output only the final assistant reply. Do not emit your reasoning process, analysis, or thinking trace.'

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

		const backend = this.env.FRIEREN_BACKEND === 'local' ? 'local' : 'openai';

		return backend === 'local'
			? {
				model: localModel,
				apiKey: 'lm-studio',
			}
			: {
				model: openaiModel,
				apiKey: this.env.OPENAI_API_KEY,
			};
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
			convertToLlm: (messages: AgentMessage[]): Message[] =>
				this.buildModelVisibleMessages(messages),
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

	private buildModelVisibleMessages(messages: AgentMessage[]): Message[] {
		const out: Message[] = [];

		for (const message of messages) {
			if (!("role" in message)) continue;

			if (message.role === "assistant") {
				const content = Array.isArray(message.content) ? message.content : [];
				const hasText = content.some(
					(block) => block.type === "text" && block.text.trim().length > 0,
				);
				const hasToolCalls = content.some((block) => block.type === "toolCall");

				// Thinking-only assistant turns are not useful model-visible context
				// for the next request. Keeping them would effectively erase the
				// assistant turn and leave the prior user message orphaned.
				if (!hasText && !hasToolCalls) continue;
			}

			if (message.role === "user") {
				const prev = out[out.length - 1];

				// Consecutive user turns indicate an earlier prompt never produced
				// durable assistant text. Keep only the latest user prompt so the
				// next model call answers the freshest request.
				if (prev?.role === "user") {
					out[out.length - 1] = message;
					continue;
				}
			}

			out.push(message);
		}

		while (out[0]?.role === "assistant") {
			out.shift();
		}

		return out;
	}

	// ── Model context rehydration (Phase A) ──────────────────────────────

	private buildRehydratedMessages(lines: ReadonlyArray<RehydrationLine>): Message[] {
		const { model } = this.getBackendConfig();
		const now = Date.now();
		const out: Message[] = [];
		for (const line of lines) {
			if (line.role === 'user') {
				out.push({
					role: 'user',
					content: line.content,
					timestamp: now,
				});
			} else {
				out.push({
					role: 'assistant',
					content: [{ type: 'text', text: line.content }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: 'stop',
					timestamp: now,
				});
			}
		}
		return out;
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
						if (block.type === 'thinking') {
							lines.push({
								ts: now,
								role: 'assistant_thinking',
								content: block.thinking,
							});
						}
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
			try {
				const prepared = await this.sessionRuntime.runPromise(prepareTurn());
				const sessionId = prepared.currentSessionId;

				const agent = await this.getOrCreateAgent();
				if (prepared.isNewSession && agent.state.messages.length > 0) {
					agent.state.messages = [];
				} else if (
					!prepared.isNewSession &&
					agent.state.messages.length === 0 &&
					sessionId
				) {
					// Cold-start resume: the DO hibernated and lost in-memory
					// agent state. Rebuild a text-only tail from the transcript
					// so the model sees the same conversation the user does.
					try {
						const lines = await this.sessionRuntime.runPromise(
							loadRehydrationMessages(sessionId),
						);
						if (lines.length > 0) {
							agent.state.messages = this.buildRehydratedMessages(lines);
						}
					} catch (err) {
						console.error('Failed to rehydrate agent messages', err);
					}
				}

				// Set systemPrompt BEFORE prompt() — the Agent snapshots it by value
				// at the start of each turn, so mid-turn mutations (e.g. inside
				// transformContext) would be ignored for the current call.
				agent.state.systemPrompt = [
					prepared.systemPrompt,
					FINAL_ANSWER_ONLY_INSTRUCTION,
				].join("\n\n---\n\n");

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
						try {
							await this.sessionRuntime.runPromise(
								maybeUpdateRollingSummary(sessionId),
							);
						} catch (err) {
							console.error('Failed to update rolling summary', err);
						}
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

			try {
				const history = await this.sessionRuntime.runPromise(loadRecentHistory());
				if (history.length > 0) {
					server.send(
						JSON.stringify({ type: "history", messages: history } satisfies ServerMessage),
					);
				}
			} catch (err) {
				console.error("Failed to load recent history", err);
			}

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
