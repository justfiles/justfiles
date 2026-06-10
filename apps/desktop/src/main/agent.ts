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
	rm,
	runtime,
	text
} from '@justfiles/agent'
import type { Kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import type { AgentMessage } from '../shared/agent'

type DesktopAgentOptions = {
	openApp: (id: string) => Promise<void>
	closeApp: (id?: string) => void
	currentAppId: () => string | null
}

export type DesktopAgent = {
	history: () => AgentMessage[]
	prompt: (input: string) => Promise<string>
	abort: () => Promise<void>
}

const COMPACTION: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000
}

export async function createDesktopAgent(
	volume: Volume,
	kernel: Kernel,
	options: DesktopAgentOptions
): Promise<DesktopAgent> {
	const registry = new CommandRegistry()
	for (const command of [cp, mv, rm, createNowCommand({}), createAppCommand(controller())]) {
		registry.register(command)
	}
	const bash = createBashTool(registry, { vol: volume })
	const fsTools = createFsTools(volume)
	const llm = llmConfig()
	const llmText = text(llm)
	const rt = await runtime({
		volume,
		agent: createAgent(llm),
		text: llmText,
		compaction: COMPACTION
	})
	rt.addTools([...fsTools.tools, createFetchTool(), createSearchTool(), bash])

	const messages: AgentMessage[] = []
	return { history, prompt, abort }

	function history(): AgentMessage[] {
		return messages.slice()
	}

	async function prompt(input: string): Promise<string> {
		const text = input.trim()
		if (!text) return ''
		messages.push({ id: crypto.randomUUID(), role: 'user', content: text })
		let answer: string
		try {
			answer = isDirectCommand(text) ? await runDirect(text) : await rt.prompt(text)
		} catch (error) {
			answer = `Agent error: ${error instanceof Error ? error.message : String(error)}`
		}
		messages.push({ id: crypto.randomUUID(), role: 'assistant', content: answer })
		return answer
	}

	// Cancel the in-flight turn (`shutdown` only aborts the running agent), leaving
	// the session intact so later prompts still work.
	async function abort(): Promise<void> {
		await rt.shutdown()
	}

	function controller(): AppController {
		return {
			list: async () =>
				(await kernel.list())
					.filter((app) => !app.id.startsWith('preview.'))
					.map((app) => ({
						id: app.id,
						name: app.name,
						description: app.description
					})),
			launch: async (id) => {
				await options.openApp(id)
				return inspect(id)
			},
			close: async (id) => options.closeApp(id),
			current: async () => {
				const id = options.currentAppId()
				return id ? inspect(id) : undefined
			},
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
		if (command.startsWith('read ')) {
			return new TextDecoder().decode(await volume.readFile(command.slice('read '.length).trim()))
		}
		if (command.startsWith('write ')) {
			const rest = command.slice('write '.length)
			const space = rest.indexOf(' ')
			if (space < 1) throw new Error('usage: write <path> <content>')
			const path = rest.slice(0, space)
			const content = rest.slice(space + 1)
			const parent = path.replace(/\/[^/]*$/, '')
			if (parent && parent !== path) await volume.mkdir(parent, { recursive: true })
			await volume.writeFile(path, new TextEncoder().encode(content))
			return `Wrote ${path}`
		}
		if (command.startsWith('ls ')) {
			return (await volume.readdir(command.slice('ls '.length).trim()))
				.map((entry) => entry.name)
				.join('\n')
		}
		const result = await bash.execute('desktop', { command })
		return result.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('\n')
	}
}

function isDirectCommand(input: string): boolean {
	return /^(app|cp|mv|rm|now|read|write|ls)\b/.test(input)
}

type LLMConfig = Parameters<typeof createAgent>[0]

export function llmConfig(): LLMConfig {
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
