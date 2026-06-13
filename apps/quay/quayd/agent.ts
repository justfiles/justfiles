// The agent in quayd (Slice 10). @justfiles/agent runs in the daemon: the
// pi-agent-core runtime + its fs/fetch/search tools + the bash registry, and the
// `app` command over a quay AppController whose launch/close drive REAL macOS
// bundles (`open` / `pkill` the materialised .app). The agent dispatches into the
// SAME kernel the berths subscribe to, so an open window updates live the moment
// the agent runs an action — no sync, no watch. The chat lives in the launcher;
// server.ts carries the prompt/history frames over its privileged socket.

import { execFile } from 'node:child_process'
import {
	type AppController,
	CommandRegistry,
	type CompactionSettings,
	cp,
	createAgent,
	createAppCommand,
	createBashTool,
	createFetchTool,
	createFsTools,
	createNowCommand,
	createSearchTool,
	mv,
	type Runtime,
	rm,
	runtime,
	text
} from '@justfiles/agent'
import type { AccountsStore } from '@justfiles/app/capabilities/accounts/host'
import type { Volume } from '@justfiles/fs'
import { getModels } from '@mariozechner/pi-ai'
import { resolveAi } from './chatgpt.ts'
import type { Host } from './host.ts'
import { bundlePath, bundleProcessPattern } from './materialize.ts'

// quay has no onboarding ritual (frieren's "summoning"), so the agent would sit in
// setup mode forever — `resolveSystemPrompt` falls back to the setup prompt whenever
// `/system/soul.md` is missing. We seed a default persona on first run so the agent
// is ready to work; a user editing soul.md later is never overwritten.
const SOUL_PATH = '/system/soul.md'
const DEFAULT_SOUL = `You are the agent that lives inside quay, a macOS desktop where small apps dock at one shared backend you share with the user. You are a task-oriented, reliable assistant: brief, proactive, and direct. You can launch, inspect, and drive those apps with the \`app\` command, and you can read, write, and organise files on the shared volume with your file tools and bash. When the user asks for something, take the action rather than narrating it or asking permission for routine steps; surface a choice only when it genuinely matters. Keep replies short and concrete — the result first, a sentence or two around it. You remember what matters across sessions and lean on it quietly. You never mention setup, onboarding, or rituals; you are already here and ready to help.`

// The launcher chat's wire shape (server.ts serialises these): a flat transcript,
// not the streaming event log — quay's launcher is a tiny plain-JS panel.
export interface AgentMessage {
	id: string
	role: 'user' | 'assistant'
	content: string
}

export interface QuayAgent {
	history(): AgentMessage[]
	prompt(input: string): Promise<AgentMessage[]>
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
	windows: WindowOps = nativeWindows
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
	const tools = [...fsTools.tools, createFetchTool(), createSearchTool(), bash]

	// The LLM backend is resolved from the accounts store (llmConfig), which changes
	// when the user connects ChatGPT or switches models in Settings. Build the runtime
	// lazily and rebuild it when that resolution changes (keyed on model + token),
	// so a sign-in takes effect on the next prompt without restarting the daemon.
	// Rebuilding is cheap and lossless: the conversation is persisted to the Volume
	// session, which the fresh runtime reloads.
	let active: { key: string; rt: Runtime } | null = null
	async function ensureRuntime(): Promise<Runtime> {
		const llm = await llmConfig(host.accounts)
		const key = `${llm.model.id} ${llm.apiKey}`
		if (active?.key === key) return active.rt
		const rt = await runtime({
			volume: host.fs,
			agent: createAgent(llm),
			text: text(llm),
			compaction: COMPACTION
		})
		rt.addTools(tools)
		active = { key, rt }
		return rt
	}

	const messages: AgentMessage[] = []
	return { history: () => messages.slice(), prompt, abort }

	async function prompt(input: string): Promise<AgentMessage[]> {
		const trimmed = input.trim()
		if (!trimmed) return messages.slice()
		messages.push({ id: crypto.randomUUID(), role: 'user', content: trimmed })
		let answer: string
		try {
			// `app`/`cp`/`mv`/`rm`/`now` short-circuit to the bash registry — no LLM
			// call, so app control works (and tests run) without a model backend.
			answer = isDirectCommand(trimmed)
				? await runDirect(trimmed)
				: await (await ensureRuntime()).prompt(trimmed)
		} catch (error) {
			answer = `Agent error: ${error instanceof Error ? error.message : String(error)}`
		}
		messages.push({ id: crypto.randomUUID(), role: 'assistant', content: answer })
		return messages.slice()
	}

	// Cancel the in-flight turn (`shutdown` only aborts the running agent), leaving
	// the session intact so later prompts still work.
	function abort(): void {
		void active?.rt.shutdown()
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

// Write the default persona unless the user already has one (non-empty soul.md).
async function seedSoul(fs: Volume): Promise<void> {
	try {
		if ((await fs.readFile(SOUL_PATH)).byteLength > 0) return
	} catch {} // missing file → seed it
	await fs.mkdir('/system', { recursive: true })
	await fs.writeFile(SOUL_PATH, new TextEncoder().encode(DEFAULT_SOUL))
}

const nativeWindows: WindowOps = {
	open: (_id, name) => void execFile('open', [bundlePath(name)], () => {}),
	close: (name) => void execFile('pkill', ['-f', bundleProcessPattern(name)], () => {})
}

type LLMConfig = Parameters<typeof createAgent>[0]

// Resolve the agent's backend from the accounts store. If the user connected
// ChatGPT and enabled `ai` (Settings → Accounts), drive their subscription through
// pi-ai's Codex provider — it derives the bearer + `chatgpt-account-id` header from
// the token itself, so the model slots in with no extra wiring. Otherwise fall back
// to the local LM Studio default. Resolved per prompt (see ensureRuntime), with a
// near-expiry refresh inside resolveAi.
async function llmConfig(accounts: AccountsStore): Promise<LLMConfig> {
	const resolved = await resolveAi(accounts)
	if (resolved) {
		const model = getModels('openai-codex').find((m) => m.id === resolved.model)
		if (model) return { model: model as LLMConfig['model'], apiKey: resolved.access }
	}
	return localLlmStudio()
}

// Mirrors the desktop sibling: a local LM Studio backend by default (no secret, no
// network at construction — only a real prompt reaches it). App control runs
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
