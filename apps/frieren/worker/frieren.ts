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

interface ClientMessage {
	type: "prompt" | "abort";
	text?: string;
}

interface ServerMessage {
	type: "event" | "error" | "ready" | "history";
	event?: AgentEvent;
	message?: string;
	messages?: SerializedMessage[];
}

interface SerializedMessage {
	role: string;
	content: string;
	toolCalls?: { name: string; args: unknown; result?: unknown; isError?: boolean }[];
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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => migrateCF(ctx.storage));
		const namespace = ctx.id.toString();
		const fs = cfFsStorage(ctx.storage, namespace);
		this.app = createFrierenApiApp({ fs });
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

		// Restore conversation from SQLite
		const saved = this.loadMessages();
		if (saved.length > 0) {
			agent.state.messages = saved;
		}

		return agent;
	}

	private async readSystemPrompt(vol: Volume): Promise<string> {
		if (!(await vol.exists(SOUL_PATH))) {
			return DEFAULT_SETUP_PROMPT;
		}

		const systemPrompt = decoder.decode(await vol.readFile(SOUL_PATH)).trim();
		return systemPrompt.length > 0 ? systemPrompt : DEFAULT_SETUP_PROMPT;
	}

	// ── Conversation persistence ──────────────────────────────────────────

	private ensureMessagesTable(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS conversation (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				data TEXT NOT NULL
			)
		`);
	}

	private saveMessages(messages: AgentMessage[]): void {
		this.ensureMessagesTable();
		this.ctx.storage.sql.exec('DELETE FROM conversation');
		for (const msg of messages) {
			this.ctx.storage.sql.exec(
				'INSERT INTO conversation (data) VALUES (?)',
				JSON.stringify(msg, bigIntReplacer),
			);
		}
	}

	private loadMessages(): AgentMessage[] {
		this.ensureMessagesTable();
		const rows = this.ctx.storage.sql.exec(
			'SELECT data FROM conversation ORDER BY seq',
		).toArray();
		return rows.map(r => JSON.parse(r.data as string));
	}

	private serializeForClient(messages: AgentMessage[]): SerializedMessage[] {
		const result: SerializedMessage[] = [];
		for (const msg of messages) {
			if (!('role' in msg)) continue;
			const m = msg as Message;
			if (m.role === 'user') {
				const text = typeof m.content === 'string'
					? m.content
					: Array.isArray(m.content)
						? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
						: '';
				result.push({ role: 'user', content: text });
			} else if (m.role === 'assistant') {
				const am = m as any;
				let text = '';
				const toolCalls: SerializedMessage['toolCalls'] = [];
				if (Array.isArray(am.content)) {
					for (const block of am.content) {
						if (block.type === 'text') text += block.text;
						if (block.type === 'toolCall') {
							toolCalls.push({ name: block.name, args: block.args });
						}
					}
				}
				result.push({ role: 'assistant', content: text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined });
			}
		}
		return result;
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
				const agent = await this.getOrCreateAgent();
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
					// Persist conversation after each completed prompt
					this.saveMessages(agent.state.messages);
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

			// Replay conversation history to the new client
			const saved = this.loadMessages();
			if (saved.length > 0) {
				const history = this.serializeForClient(saved);
				server.send(
					JSON.stringify({ type: "history", messages: history } satisfies ServerMessage),
				);
			}

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

		return this.app.fetch(request);
	}
}

function bigIntReplacer(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? value.toString() : value;
}
