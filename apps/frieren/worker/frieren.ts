import { DurableObject } from "cloudflare:workers";
import { getModel } from "@mariozechner/pi-ai";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { volume, type Volume } from "@justfiles/fs";
import { cfFsStorage, migrateCF } from "./db.do.ts";
import { createFrierenApiApp, type FrierenApiType } from './app.ts';
import { createFsTools, createFetchTool, createSearchTool } from "./tools.ts";
import { runtime, type Runtime } from './frieren.runtime';
import type { SessionEntry } from "./session.manager.ts";
import { text } from './llm.text';
import type { CompactionSettings } from './compaction';
import { createAgent } from './llm.agent';

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

const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

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
			agent: this.buildAgent(),
			text: text({model, apiKey}),
			compaction: DEFAULT_COMPACTION_SETTINGS
		})
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

	private buildAgent() {
		const fs = createFsTools(this.vol);
		const agent = createAgent(this.getBackendConfig());
		agent.state.tools = [...fs.tools, createFetchTool(), createSearchTool()];
		return agent;
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
