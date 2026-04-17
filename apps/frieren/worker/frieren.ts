import { DurableObject } from "cloudflare:workers";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { volume, type Volume } from "@justfiles/fs";
import { cfFsStorage, migrateCF } from "./db.do.ts";
import { createFrierenApiApp, type FrierenApiType } from './app.ts';
import { createFsTools, createFetchTool, createSearchTool } from "./tools.ts";
import { runtime, type Runtime } from './frieren.runtime';
import type { SessionEntry } from "./session.manager.ts";
import { text } from './llm.text';

interface ClientMessage {
	type: "prompt" | "abort";
	text?: string;
}

interface DisplayToolCall {
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
}

interface DisplayMessage {
	readonly role: 'user' | 'assistant'
	readonly content: string
	readonly thinking?: string
	readonly toolCalls?: ReadonlyArray<DisplayToolCall>
}

interface ServerMessage {
	// TODO: remove debug
	type: "debug" | "event" | "error" | "ready" | "history";
	event?: AgentEvent;
	message?: string;
	messages?: ReadonlyArray<DisplayMessage>;
}


const DEBUG_COMMAND = '/debug'

export class Frieren extends DurableObject<Env> {
	private readonly app: FrierenApiType;
	private readonly vol: Volume;
	private runtime?: Runtime;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const namespace = ctx.id.toString();
		const fs = cfFsStorage(ctx.storage, namespace);
		this.vol = volume(fs);
		this.app = createFrierenApiApp({
				fs,
				onNuke: async () => {
					await ctx.storage.deleteAll();
					await this.reset()
				},
			});
			ctx.blockConcurrencyWhile(async () => {
				await this.reset()
			});
		}

	private async reset() {
		const { model, apiKey } = this.getBackendConfig()
		await migrateCF(this.ctx.storage);
		this.runtime?.shutdown()
		this.runtime = await runtime({
			volume: this.vol,
			agent: this.createAgent(),
			text: text({model, apiKey})})
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

		if (backend === 'local') {
			return { model: localModel, apiKey: 'lm-studio' };
		}

		const apiKey = this.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error(
				'OPENAI_API_KEY is not set. Add it to apps/frieren/.dev.vars (local) or as a Cloudflare secret (deployed), and declare it in wrangler.jsonc `secrets.required`.',
			);
		}
		return { model: openaiModel, apiKey };
	}

	private createAgent(): Agent {
		const { model, apiKey } = this.getBackendConfig();

		const fs = createFsTools(this.vol);
		const tools = [...fs.tools, createFetchTool(), createSearchTool()];

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
			beforeToolCall: fs.beforeToolCall,
			afterToolCall: fs.afterToolCall,
		});

		// TODO: cut off line threads
		agent.transformContext = async (messages) => messages;

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
			this.runtime?.shutdown()
			return;
		}

		if (parsed.type === "prompt" && parsed.text) {
			const sp = this.runtime?._agent().state.systemPrompt
			if (parsed.text.trim() === DEBUG_COMMAND) {
				ws.send(
					JSON.stringify({
						type: 'debug',
						message: sp,
					} satisfies ServerMessage),
				)
				return
			}

			const unsubscribe = this.runtime?.subscribe(
				(event, _signal) => {
					ws.send(
						JSON.stringify({
							type: "event",
							event,
						} satisfies ServerMessage),
					);
				},
			);
			await this.runtime?.prompt(parsed.text)
			unsubscribe?.()
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

			const history = (await this.runtime?.history() ?? []).map(sessionEntry2DisplayMessage)
			if (history.length > 0) {
			server.send(
			JSON.stringify({ type: "history", messages: history } satisfies ServerMessage),
			);
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

function sessionEntry2DisplayMessage(entry: SessionEntry): DisplayMessage {
	switch (entry.type) {
		case 'message':
			switch (entry.role) {
				case 'user':
					return { role: 'user', content: entry.content }
				case 'assistant':
					return { role: 'assistant', content: entry.content }
				case 'assistant_thinking':
					return { role: 'assistant', content: '', thinking: entry.content }
				case 'tool_call':
					return { role: 'assistant', content: '', toolCalls: [{ name: entry.tool_name, args: entry.input }] }
				case 'tool_result':
					return { role: 'assistant', content: `[${entry.tool_name}]: ${entry.content}` }
			}
		case 'compaction':
			return { role: 'assistant', content: entry.summary }
		case 'branch_summary':
			return { role: 'assistant', content: entry.summary }
		case 'label':
			return { role: 'assistant', content: `[${entry.label}]` }
	}
}
