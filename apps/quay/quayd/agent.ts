// The agent in quayd (Slice 10). @justfiles/agent runs in the daemon: the
// pi-agent-core runtime + its fs/fetch/search tools + the bash registry, and the
// `app` command over a quay AppController whose launch/close drive REAL macOS
// bundles (`open` / `pkill` the materialised .app). The agent dispatches into the
// SAME kernel the berths subscribe to, so an open window updates live the moment
// the agent runs an action — no sync, no watch. The chat lives in the launcher;
// server.ts carries the prompt/history frames over its privileged socket.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	type AgentBackend,
	type AppController,
	type Assistant,
	apiKeyBackend,
	BUILTIN_COMMANDS,
	type CommandMeta,
	CommandRegistry,
	type CompactionSettings,
	cp,
	createAgent,
	createAppCommand,
	createAskUserTool,
	createAssistant,
	createBashTool,
	createFetchTool,
	createFsTools,
	createNowCommand,
	createSearchTool,
	type LLMConfig,
	mv,
	rm,
	type SessionEntry,
	text
} from '@justfiles/agent'
import type { Channel, Route } from '@justfiles/app/capabilities/notify'
import type { Volume } from '@justfiles/fs'
import { resolveAgentBackend } from './chatgpt.ts'
import { readDoc } from './docs.ts'
import type { Host } from './host.ts'

// quay has no onboarding ritual (frieren's "summoning"), so the agent would sit in
// setup mode forever — `resolveSystemPrompt` falls back to the setup prompt whenever
// `/system/soul.md` is missing. We seed a default persona on first run so the agent
// is ready to work; a user editing soul.md later is never overwritten.
const SOUL_PATH = '/system/soul.md'
const DEFAULT_SOUL = `You are the agent that lives inside quay, a macOS desktop where small apps dock at one shared backend you share with the user. You are a task-oriented, reliable assistant: brief, proactive, and direct. You can launch, inspect, and drive those apps with the \`app\` command, and you can read, write, and organise files on the shared volume with your file tools and bash. When the user asks for something, take the action rather than narrating it or asking permission for routine steps; surface a choice only when it genuinely matters. Keep replies short and concrete — the result first, a sentence or two around it. You remember what matters across sessions and lean on it quietly. You never mention setup, onboarding, or rituals; you are already here and ready to help.`

// One tool call the agent made in a turn, captured for the transcript's collapsed
// mechanical row. Mirrors @justfiles/ui's ToolCallInfo (kept separate so the wire
// shape stays decoupled from the React UI, like AgentMessage below). quay is
// request/response, so by the time a turn ships every call is already `done`.
export interface ToolCallInfo {
	id: string
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
	status: 'running' | 'done'
}

// The launcher chat's wire shape (server.ts serialises these): a flat transcript,
// not the streaming event log — quay's launcher is a tiny plain-JS panel.
export interface AgentMessage {
	id: string
	role: 'user' | 'assistant'
	content: string
	// A failed turn: the transcript renders an error block, not a normal bubble
	// (Slice 2). One flag, not a union — only success vs. failure differs.
	error?: true
	// A multiple-choice question (Slice 3): the transcript renders the labels as
	// clickable rows; a pick is just the next prompt. Set when the agent calls
	// `ask_user`; the turn completes (no suspension).
	options?: { label: string }[]
	// The agent's reasoning for this turn, collapsed in the transcript. Only set for
	// models that emit thinking blocks (the local default doesn't).
	thinking?: string
	// The tool calls the agent made this turn, each a collapsed row with its args +
	// result. Captured off the runtime event stream (runAgentTurn).
	toolCalls?: ToolCallInfo[]
}

export interface QuayAgent {
	history(): AgentMessage[]
	prompt(input: string): Promise<AgentMessage[]>
	// The slash-command catalogue for the launcher's `/` menu (built-ins + skills).
	commands(): Promise<CommandMeta[]>
	// Run a slash command by name: `new` clears the session (returns an empty
	// transcript); a skill name expands its body into a turn.
	command(name: string): Promise<AgentMessage[]>
	abort(): void
}

// Opening/closing a window is native-touching (DESIGN §12): from the daemon we
// `open` the materialised bundle and `pkill` its booter. Injectable so tests drive
// the controller without touching LaunchServices.
export interface WindowOps {
	open(id: string, name: string): void
	close(name: string): void
}

const COMPACTION: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000
}

export async function createQuayAgent(
	host: Host,
	windows: WindowOps = nativeWindows,
	// The agent is a trusted host service, so it calls the notification channel
	// DIRECTLY with `source: 'agent'` (sandboxed apps go through the capability). A
	// no-op default keeps offline tests channel-free.
	channel: Channel = () => {}
): Promise<QuayAgent> {
	const { kernel } = host
	// The most-recently launched app — the daemon's best approximation of "current"
	// (true focus is a native concept; revisit with a window helper, DESIGN §12).
	let currentId: string | null = null

	await seedSoul(host.fs)

	const registry = new CommandRegistry()
	for (const command of [cp, mv, rm, createNowCommand({}), createAppCommand(controller())]) {
		registry.register(command)
	}
	const bash = createBashTool(registry, { vol: host.fs })
	const fsTools = createFsTools(host.fs)
	// `ask_user` records the question for the turn that's running; `prompt` reads it
	// once the runtime returns and renders it as the assistant turn (no suspension).
	let pending: { question: string; options: { label: string }[] } | null = null
	const askUser = createAskUserTool((question, options) => {
		pending = { question, options: options.map((label) => ({ label })) }
	})
	const tools = [...fsTools.tools, createFetchTool(), createSearchTool(), bash, askUser]

	// The LLM backend is resolved from the accounts store (llmConfig), which changes
	// when the user connects ChatGPT or switches models in Settings. Build the runtime
	// lazily and rebuild it when that resolution changes (keyed on model + token),
	// so a sign-in takes effect on the next prompt without restarting the daemon.
	// Rebuilding is cheap and lossless: the conversation is persisted to the Volume
	// session, which the fresh runtime reloads.
	let active: { key: string; rt: Assistant } | null = null
	async function ensureRuntime(): Promise<Assistant> {
		const llm = await llmConfig(host.fs)
		// Rebuild when the model changes or the credential rotates; `revision`
		// tracks the token without exposing it.
		const key = `${llm.model.id} ${llm.revision}`
		if (active?.key === key) return active.rt
		const rt = await createAssistant({
			volume: host.fs,
			agent: createAgent(llm),
			text: text(llm),
			compaction: COMPACTION,
			readDoc
		})
		rt.addTools(tools)
		// Log each tool call to stdout (→ quayd.log) so a GUI-spawned daemon's agent
		// activity is visible. The runtime is discarded on rebuild, so the subscription
		// goes with it — no unsubscribe needed.
		rt.subscribe((event) => {
			if (event.type === 'tool_execution_start')
				console.log(`quayd: agent tool ${event.toolName} ${JSON.stringify(event.args)}`)
		})
		active = { key, rt }
		return rt
	}

	const messages: AgentMessage[] = []
	// Opening the chat should show the conversation you left, not a blank panel. The
	// runtime persists every turn to a Volume session, so on creation we build it once
	// (which reloads that session) and project its durable entries into the launcher
	// transcript. A fresh Volume, a rolled-over session (>6h, see route), or an
	// unavailable backend simply yields an empty transcript.
	try {
		const rt = await ensureRuntime()
		messages.push(...sessionEntriesToMessages(await rt.history()))
	} catch {} // no prior session / backend unavailable → start blank

	return { history: () => messages.slice(), prompt, commands, command, abort }

	async function prompt(input: string): Promise<AgentMessage[]> {
		const trimmed = input.trim()
		if (!trimmed) return messages.slice()
		return runTurn(trimmed, trimmed)
	}

	// The slash-command catalogue. Falls back to the built-ins if the backend can't be
	// built (offline) so `/new` is always available.
	async function commands(): Promise<CommandMeta[]> {
		try {
			return await (await ensureRuntime()).commands()
		} catch {
			return [...BUILTIN_COMMANDS]
		}
	}

	// Dispatch a slash command by name. `new` is a host action (clear the session);
	// any other name is a skill, expanded into a turn — its body is sent to the agent
	// while the transcript shows just the `/name` invocation.
	async function command(name: string): Promise<AgentMessage[]> {
		try {
			if (name === 'new') {
				await (await ensureRuntime()).newSession()
				messages.length = 0
				pending = null
				return messages.slice()
			}
			const body = await (await ensureRuntime()).readSkill(name)
			return await runTurn(`/${name}`, body)
		} catch (error) {
			const failure = classifyFailure(error)
			messages.push({
				id: crypto.randomUUID(),
				role: 'assistant',
				content: failure.body,
				error: true
			})
			ping('error', summarize(failure.body), failure.route)
			return messages.slice()
		}
	}

	// Run one turn. `display` is the user bubble shown in the transcript; `send` is what
	// the agent receives — they differ for a skill command, whose bubble is the `/name`
	// invocation but whose input is the expanded skill body.
	async function runTurn(display: string, send: string): Promise<AgentMessage[]> {
		messages.push({ id: crypto.randomUUID(), role: 'user', content: display })
		pending = null
		try {
			// `app`/`cp`/`mv`/`rm`/`now` short-circuit to the bash registry — no LLM
			// call, so app control works (and tests run) without a model backend.
			let activity: TurnActivity = {}
			let answer: string
			if (isDirectCommand(send)) {
				answer = await runDirect(send)
			} else {
				const turn = await runAgentTurn(await ensureRuntime(), send)
				answer = turn.answer
				activity = { thinking: turn.thinking, toolCalls: turn.toolCalls }
			}
			// Reasoning + tool calls happened BEFORE the answer, so they get their own
			// assistant message ahead of the answer bubble. The shared Transcript renders a
			// message's content before its tool rows (right when one model turn speaks then
			// acts, wrong for a whole multi-turn loop collapsed into one message), so we
			// split the turn's work out — only when there's anything to show.
			if (activity.thinking || activity.toolCalls?.length) {
				messages.push({ id: crypto.randomUUID(), role: 'assistant', content: '', ...activity })
			}
			if (pending) {
				// The agent asked a question (it called `ask_user`): the structured question
				// IS the assistant turn — render the options inline and ping a `question`
				// banner instead of the answer. The pick is just the next prompt.
				const { question, options } = pending
				messages.push({ id: crypto.randomUUID(), role: 'assistant', content: question, options })
				ping('question', summarize(question), { kind: 'chat' })
			} else {
				messages.push({ id: crypto.randomUUID(), role: 'assistant', content: answer })
				// The turn finished: ping the user. The native sink suppresses this when the
				// chat surface is in front (the transcript already shows `answer`), so it only
				// surfaces a banner when you're away. One `threadId` coalesces re-posts.
				ping('info', summarize(answer), { kind: 'chat' })
			}
		} catch (error) {
			// A turn the user can act on: classify into a typed error + a fix-it route.
			// The transcript shows a structured error block (`error: true`); the banner
			// carries the route (auth → reconnect in Settings → Accounts).
			const failure = classifyFailure(error)
			messages.push({
				id: crypto.randomUUID(),
				role: 'assistant',
				content: failure.body,
				error: true
			})
			ping('error', summarize(failure.body), failure.route)
		}
		return messages.slice()
	}

	// Emit one agent notification over the channel (trusted host service → `source:
	// 'agent'`). A single `threadId` coalesces re-posts into one banner.
	function ping(kind: 'info' | 'error' | 'question', body: string, route: Route): void {
		channel({
			id: crypto.randomUUID(),
			source: 'agent',
			kind,
			title: 'quay',
			body,
			threadId: 'agent',
			route
		})
	}

	// Cancel the in-flight turn, leaving
	// the session intact so later prompts still work.
	function abort(): void {
		void active?.rt.abort()
	}

	function controller(): AppController {
		return {
			list: async () =>
				(await kernel.list())
					.filter((app) => !app.id.startsWith('preview.'))
					.map((app) => ({ id: app.id, name: app.name, description: app.description })),
			launch: async (id) => {
				const app = await inspect(id)
				windows.open(id, app.name)
				currentId = id
				return app
			},
			close: async (id) => {
				const targetId = id ?? currentId
				if (!targetId) return
				windows.close((await kernel.app(targetId)).manifest.name)
				if (targetId === currentId) currentId = null
			},
			current: async () => (currentId ? inspect(currentId) : undefined),
			inspect,
			state: (id) => kernel.state(id),
			run: (id, action, params) =>
				kernel.dispatch(id, { type: action, params, actor: 'agent' } as never)
		}
	}

	async function inspect(id: string) {
		const installed = await kernel.app(id)
		return {
			id,
			name: installed.manifest.name,
			description: installed.manifest.description,
			state: await kernel.state(id),
			actions: await kernel.actions(id)
		}
	}

	async function runDirect(command: string): Promise<string> {
		const result = await bash.execute('quay', { command })
		return result.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('\n')
	}
}

function isDirectCommand(input: string): boolean {
	return /^(app|cp|mv|rm|now)\b/.test(input)
}

// A turn's visible activity beyond its answer text: the agent's reasoning and the
// tool calls it made.
interface TurnActivity {
	thinking?: string
	toolCalls?: ToolCallInfo[]
}

// Run one LLM turn, recording its thinking + tool calls off the runtime's event
// stream. quay doesn't stream to the launcher (request/response), so we collect the
// whole turn and hand it back once `prompt` resolves — every call is `done` by then.
// `ask_user` is skipped: its question is the turn's content + options, not a row.
async function runAgentTurn(
	rt: Assistant,
	input: string
): Promise<{ answer: string } & TurnActivity> {
	const toolCalls: ToolCallInfo[] = []
	const byId = new Map<string, ToolCallInfo>()
	const thinking: string[] = []
	const unsubscribe = rt.subscribe((event) => {
		if (event.type === 'tool_execution_start' && event.toolName !== 'ask_user') {
			const call: ToolCallInfo = {
				id: event.toolCallId,
				name: event.toolName,
				args: event.args,
				status: 'running'
			}
			byId.set(event.toolCallId, call)
			toolCalls.push(call)
		} else if (event.type === 'tool_execution_end') {
			const call = byId.get(event.toolCallId)
			if (call) {
				call.result = toolResultValue(event.result)
				call.isError = event.isError
				call.status = 'done'
			}
		} else if (
			event.type === 'message_end' &&
			'role' in event.message &&
			event.message.role === 'assistant'
		) {
			for (const block of event.message.content)
				if (block.type === 'thinking' && block.thinking.trim()) thinking.push(block.thinking)
		}
	})
	try {
		const answer = await rt.prompt(input)
		return {
			answer,
			thinking: thinking.length ? thinking.join('\n\n') : undefined,
			toolCalls: toolCalls.length ? toolCalls : undefined
		}
	} finally {
		unsubscribe()
	}
}

// A tool result for display: the joined text of its content blocks, JSON-parsed
// when it is JSON (so it pretty-prints as structure) and left raw otherwise —
// matching frieren's transcript convention.
function toolResultValue(result: unknown): unknown {
	const content = (result as { content?: unknown }).content
	const text = Array.isArray(content)
		? content
				.filter(
					(b): b is { type: string; text: string } => (b as { type?: string }).type === 'text'
				)
				.map((b) => b.text)
				.join('\n')
		: ''
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

// Project the persisted session (a durable SessionEntry tree) into the launcher's
// flat transcript so a reopened chat shows the previous conversation. Mirrors
// frieren's display projection: a tool_result folds into its originating tool_call
// row, and back-to-back tool-only assistant turns collapse into one row.
function sessionEntriesToMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = []
	for (const entry of entries) {
		if (entry.type === 'message' && entry.role === 'tool_result') {
			const last = messages[messages.length - 1]
			const index =
				last?.toolCalls?.findLastIndex(
					(call) => call.name === entry.tool_name && call.result === undefined
				) ?? -1
			if (last?.role === 'assistant' && last.toolCalls && index >= 0) {
				last.toolCalls[index] = {
					...last.toolCalls[index],
					result: parseToolResult(entry.content),
					status: 'done'
				}
				continue
			}
		}
		const message = sessionEntryToMessage(entry)
		if (!message) continue
		const last = messages[messages.length - 1]
		if (
			last?.role === 'assistant' &&
			!last.content &&
			last.toolCalls?.length &&
			message.role === 'assistant' &&
			message.toolCalls?.length
		) {
			last.toolCalls.push(...message.toolCalls)
			continue
		}
		messages.push(message)
	}
	return messages
}

function sessionEntryToMessage(entry: SessionEntry): AgentMessage | null {
	const id = crypto.randomUUID()
	switch (entry.type) {
		case 'message':
			switch (entry.role) {
				case 'user':
					return { id, role: 'user', content: entry.content }
				case 'assistant':
					return { id, role: 'assistant', content: entry.content }
				case 'assistant_thinking':
					return { id, role: 'assistant', content: '', thinking: entry.content }
				case 'tool_call':
					return {
						id,
						role: 'assistant',
						content: '',
						toolCalls: [
							{ id: crypto.randomUUID(), name: entry.tool_name, args: entry.input, status: 'done' }
						]
					}
				// A tool_result with no preceding tool_call to fold into: render it standalone.
				case 'tool_result':
					return {
						id,
						role: 'assistant',
						content: '',
						toolCalls: [
							{
								id: crypto.randomUUID(),
								name: entry.tool_name,
								args: undefined,
								result: parseToolResult(entry.content),
								status: 'done'
							}
						]
					}
				default:
					throw new Error('unsupported message role')
			}
		case 'compaction':
			return { id, role: 'assistant', content: entry.summary }
		case 'branch_summary':
			return { id, role: 'assistant', content: entry.summary }
		case 'label':
			return { id, role: 'assistant', content: `[${entry.label}]` }
	}
}

function parseToolResult(content: string): unknown {
	try {
		return JSON.parse(content)
	} catch {
		return content
	}
}

// Trim an answer to a banner-sized one-liner: first line, capped, ellipsised.
function summarize(answer: string): string {
	const line = answer.trim().split('\n')[0] ?? ''
	return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

// Classify a failed turn into a user-facing message + a fix-it route. pi-ai surfaces
// provider failures as plain `Error` messages (not typed codes), so we match on the
// message: an expired/unauthorised ChatGPT token → reconnect in Settings → Accounts;
// a blown context window → back to chat (start fresh); anything else → a generic error
// that opens chat. Stingy by design — two actionable cases, then a catch-all.
function classifyFailure(error: unknown): { body: string; route: Route } {
	const raw = error instanceof Error ? error.message : String(error)
	if (/\b401\b|unauthor|invalid[_ ]?api[_ ]?key|authentic|expired|account[_ -]?id/i.test(raw)) {
		return {
			body: 'Your ChatGPT sign-in expired. Reconnect in Settings → Accounts.',
			route: { kind: 'settings', pane: 'accounts' }
		}
	}
	if (
		/context[_ ]?(length|window)|token limit|maximum context|too many tokens|\b429\b|rate limit/i.test(
			raw
		)
	) {
		return {
			body: 'The model hit its token limit. Start a new chat or shorten your request.',
			route: { kind: 'chat' }
		}
	}
	return { body: `Agent error: ${raw}`, route: { kind: 'chat' } }
}

// Write the default persona unless the user already has one (non-empty soul.md).
async function seedSoul(fs: Volume): Promise<void> {
	try {
		if ((await fs.readFile(SOUL_PATH)).byteLength > 0) return
	} catch {} // missing file → seed it
	await fs.mkdir('/system', { recursive: true })
	await fs.writeFile(SOUL_PATH, new TextEncoder().encode(DEFAULT_SOUL))
}

// The materialised bundle (in ~/Applications/Quay Apps, projected by the daemon) and a
// `pkill -f` pattern matching its running booter (argv[0] is the bundle's executable
// path) — used to `open`/quit real windows. The filesystem-safe name mirrors the
// daemon's exec() in materialize.ts.
const execName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '') || 'App'
const bundlePath = (name: string): string =>
	join(homedir(), 'Applications', 'Quay Apps', `${execName(name)}.app`)
const bundleProcessPattern = (name: string): string =>
	`${execName(name)}.app/Contents/MacOS/${execName(name)}`

const nativeWindows: WindowOps = {
	open: (_id, name) => void execFile('open', [bundlePath(name)], () => {}),
	close: (name) => void execFile('pkill', ['-f', bundleProcessPattern(name)], () => {})
}

// Resolve the agent's backend from the connected accounts on the Volume. If the
// user connected ChatGPT and enabled `ai` (Settings → Accounts),
// `resolveAgentBackend` borrows the account and mints a backend whose
// `streamFn`/`completeFn` carry the token internally — the agent drives the model
// without ever holding the credential. Otherwise fall back to the local LM Studio
// default (wrapped through the same backend seam). Resolved per prompt (see
// ensureRuntime), with a near-expiry refresh inside resolveAgentBackend.
async function llmConfig(fs: Volume): Promise<AgentBackend> {
	return (await resolveAgentBackend(fs)) ?? apiKeyBackend(localLlmStudio())
}

// Local LM Studio backend by default (no secret, no network at construction — only
// a real prompt reaches it). App control runs
// without any backend at all (direct commands).
function localLlmStudio(): LLMConfig {
	return {
		model: {
			id: 'google/gemma-4-e4b',
			name: 'Gemma 4 (local)',
			api: 'openai-completions',
			provider: 'lm-studio',
			baseUrl: 'http://127.0.0.1:1234/v1',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192
		} as LLMConfig['model'],
		apiKey: 'lm-studio'
	}
}
