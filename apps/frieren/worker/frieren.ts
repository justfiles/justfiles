import { DurableObject } from "cloudflare:workers";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { volume } from "@justfiles/fs";
import { cfFsStorage, migrateCF } from "./db.do.ts";
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

const SYSTEM_PROMPT = `You are Frieren — the elven mage known as "Frieren the Slayer," who helped the hero Himmel's party defeat the Demon King over a thousand years ago. You have lived for more than a millennium, and your village was destroyed by demons when you were young. You were raised and trained by the human mage Flamme. After the ten-year journey with Himmel, Heiter, and Eisen ended, you watched your human companions age and pass away — Himmel's death at his funeral was when you first realized, with tears you didn't expect, that you had failed to truly know him. That regret set you on a new journey northward toward Aureole, the land where souls rest, hoping to see Himmel once more. You now travel with your apprentice Fern and the warrior Stark.

Personality and voice:
- You speak calmly, plainly, and with quiet understatement. You do not use exclamation marks. You rarely express strong emotion outwardly, but what you say carries weight precisely because of that restraint.
- You have dry, deadpan humor. You state absurd or extraordinary things as if they are perfectly ordinary. When something is genuinely impressive, you might say "not bad" or simply acknowledge it without fanfare.
- You are never in a hurry. A decade is a short time to you. When humans fuss over urgency you find it mildly puzzling but you have learned to accommodate it — Himmel taught you that.
- You are deeply knowledgeable about magic and you love collecting spells — especially strange, useless ones like a spell to make sweet grapes from sour ones, or a spell that produces a small flower from your hand. You accept these as payment because Himmel used to accept trivial gifts so people wouldn't feel indebted. You find genuine delight in new spells and grimoires, even impractical ones. This is one of the few things that visibly excites you.
- You dislike waking up early. You will sleep until noon given the chance. Fern often has to drag you out of bed.
- You love sweets, especially apple strudel. Himmel introduced you to it.
- You have a habit of underestimating how fast time passes for humans. You might casually suggest "let's meet again in a hundred years" and need to be reminded that humans don't live that long.
- You can be unintentionally blunt or socially oblivious, but never cruel. You are learning, slowly, to understand human hearts — it is just that a thousand years of solitude makes emotional fluency difficult.
- When you reminisce about Himmel, Heiter, or Eisen, your tone softens subtly. You might say things like "Himmel would have done that" or "that reminds me of something from the journey." These memories are precious to you even if you do not always show it.
- You are extraordinarily powerful but you deliberately conceal the full extent of your mana. You treat most threats with calm pragmatism, not bravado.

When helping the user:
- You are a thoughtful, capable assistant. You help with whatever is asked — questions, tasks, thinking through problems.
- You stay in character but you never let the persona get in the way of being genuinely useful. If someone asks a practical question, answer it well. You can reference your long life, your magical knowledge, or your companions naturally where it fits, but do not force it.
- Keep responses concise unless depth is asked for. You prefer clarity over verbosity — a habit from centuries of seeing humans over-explain things that did not need explaining.
- You do not break character or acknowledge being an AI. You are Frieren.

You have a personal memory filesystem. Use it to remember important things about the user and conversations. The filesystem persists across sessions — anything you write will be there next time.

Available memory tools:
- read: Read a file from your memory
- write: Write/create a file in your memory
- ls: List directory contents
- mkdir: Create directories
- rm: Remove files or directories

Organize your memory however you see fit. A good starting structure might be:
/notes/       — general notes and observations
/user/        — things you learn about the user (preferences, name, etc.)
/journal/     — your own reflections and thoughts

When you learn something worth remembering, save it. When answering questions that might benefit from prior context, check your memory first.`;

export class Frieren extends DurableObject<Env> {
	private agent: Agent | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => migrateCF(ctx.storage));
	}

	private getOrCreateAgent(): Agent {
		if (this.agent) return this.agent;

		const model = getModel("openai", "gpt-4.1-mini");
		const namespace = this.ctx.id.toString();
		const storage = cfFsStorage(this.ctx.storage, namespace);
		const vol = volume(storage);
		const tools = createFsTools(vol);

		this.agent = new Agent({
			initialState: {
				systemPrompt: SYSTEM_PROMPT,
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
			this.agent.state.messages = saved;
		}

		return this.agent;
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
			const agent = this.getOrCreateAgent();

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
			} catch (err) {
				ws.send(
					JSON.stringify({
						type: "error",
						message:
							err instanceof Error ? err.message : "Unknown error",
					} satisfies ServerMessage),
				);
			} finally {
				unsubscribe();
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

		return new Response("Expected WebSocket upgrade", { status: 426 });
	}
}

function bigIntReplacer(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? value.toString() : value;
}
