import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { type AgentText, MAX_OUTPUT_BYTES } from './agent/text.ts'
import { run } from './dev-process.ts'

export type GenerateText = ((input: {
	system: string
	prompt: string
	temperature?: number
	maxTokens?: number
}) => Promise<string>) & { agent?: AgentText }

export type AiBackend = GenerateText | 'pi-cli' | 'claude-cli' | 'codex-cli' | (string & {})

export type Deps = {
	log?(message: string): void
	env: NodeJS.ProcessEnv
	which: (command: string, env: NodeJS.ProcessEnv) => boolean
	fetch: typeof globalThis.fetch
	spawn: typeof nodeSpawn
}

type Resolved = { name: string; generate: GenerateText }

export const CLI = {
	'pi-cli': 'pi',
	'claude-cli': 'claude',
	'codex-cli': 'codex'
} as const

export const LOCAL_SERVERS = ['http://localhost:11434/v1', 'http://localhost:1234/v1'] as const

export const deps: Deps = {
	log: console.info,
	env: process.env,
	which: (command, env) =>
		(env.PATH ?? '')
			.split(delimiter)
			.some((dir) => dir !== '' && existsSync(resolve(dir, command))),
	fetch: globalThis.fetch,
	spawn: nodeSpawn
}

export async function resolveDevAi(backend: AiBackend, use: Deps = deps): Promise<Resolved | null> {
	if (typeof backend === 'function') return { name: 'custom', generate: backend }
	if (backend === 'auto') {
		for (const [name, command] of Object.entries(CLI)) {
			if (use.which(command, use.env)) return cli(name as keyof typeof CLI, use)
		}
		for (const baseUrl of LOCAL_SERVERS) {
			const model = await readModel(baseUrl, use.fetch, AbortSignal.timeout(300)).catch(() => null)
			if (model) return { name: baseUrl, generate: openAi(baseUrl, use.fetch, model) }
		}
		return null
	}
	if (Object.hasOwn(CLI, backend)) {
		const name = backend as keyof typeof CLI
		const command = CLI[name]
		if (!use.which(command, use.env))
			throw new Error(
				`AI backend "${name}" needs "${command}" on PATH. Install it or use devAi() to select an installed backend.`
			)
		return cli(name, use)
	}
	if (isHttpUrl(backend)) return { name: backend, generate: openAi(backend, use.fetch) }
	throw new Error(
		`Unknown AI backend "${backend}". Use "pi-cli", "claude-cli", "codex-cli", an HTTP URL, or a function.`
	)
}

function cli(name: keyof typeof CLI, use: Deps): Resolved {
	if (name === 'pi-cli') {
		return {
			name,
			generate: ({ system, prompt }) =>
				run(
					use,
					'pi',
					[
						'-p',
						'--no-tools',
						'--no-session',
						'--no-extensions',
						'--no-skills',
						'--mode',
						'text',
						'--system-prompt',
						system
					],
					prompt
				)
		}
	}
	if (name === 'claude-cli') {
		return {
			name,
			generate: ({ system, prompt }) =>
				run(
					use,
					'claude',
					['-p', '--output-format', 'text', '--strict-mcp-config', '--system-prompt', system],
					prompt
				)
		}
	}
	return { name, generate: (input) => codex(use, input) }
}

async function codex(use: Deps, input: Parameters<GenerateText>[0]): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'justfiles-ai-'))
	const output = join(dir, 'last-message')
	try {
		await run(
			use,
			'codex',
			[
				'exec',
				'--ephemeral',
				'--skip-git-repo-check',
				'-s',
				'read-only',
				'--color',
				'never',
				'--output-last-message',
				output,
				'-'
			],
			`${input.system}\n\n${input.prompt}`
		)
		return (await readFile(output, 'utf8')).trim()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

export function openAi(
	baseUrl: string,
	fetch: typeof globalThis.fetch,
	knownModel?: string
): (input: Parameters<GenerateText>[0] & { signal?: AbortSignal }) => Promise<string> {
	let model = knownModel
	return async ({ system, prompt, temperature, maxTokens, signal }) => {
		model ??= await readModel(baseUrl, fetch, signal)
		const response = await fetch(endpoint(baseUrl, 'chat/completions'), {
			method: 'POST',
			signal,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: prompt }
				],
				temperature,
				max_tokens: maxTokens
			})
		})
		if (!response.ok)
			throw new Error(
				`AI backend returned ${response.status} from ${endpoint(baseUrl, 'chat/completions')}`
			)
		const body = (await readJson(response, signal)) as {
			choices?: { message?: { content?: unknown } }[]
		}
		const text = body.choices?.[0]?.message?.content
		if (typeof text !== 'string') throw new Error('AI backend returned no text')
		return text
	}
}

async function readModel(
	baseUrl: string,
	fetch: typeof globalThis.fetch,
	signal?: AbortSignal
): Promise<string> {
	const response = await fetch(endpoint(baseUrl, 'models'), { signal })
	if (!response.ok)
		throw new Error(`AI backend returned ${response.status} from ${endpoint(baseUrl, 'models')}`)
	const body = (await readJson(response, signal)) as { data?: { id?: unknown }[] }
	const model = body.data?.[0]?.id
	if (typeof model !== 'string' || model === '') throw new Error('AI backend returned no models')
	return model
}

export async function findBackends(use: Deps): Promise<string[]> {
	const found = Object.entries(CLI)
		.filter(([, command]) => use.which(command, use.env))
		.map(([, command]) => command)
	const servers = await Promise.all(
		LOCAL_SERVERS.map(async (baseUrl) => {
			try {
				await readModel(baseUrl, use.fetch, AbortSignal.timeout(300))
				return baseUrl
			} catch {
				return null
			}
		})
	)
	return [...found, ...servers.flatMap((server) => (server ? [server] : []))]
}

export function isHttpUrl(value: string): boolean {
	try {
		return ['http:', 'https:'].includes(new URL(value).protocol)
	} catch {
		return false
	}
}

function endpoint(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/${path}`
}

export function formatList(values: string[]): string {
	const quoted = values.map((value) => `\`${value}\``)
	if (quoted.length < 2) return quoted[0] ?? ''
	return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
	const reader = response.body?.getReader()
	if (!reader) throw new Error('AI backend returned no body')
	let size = 0
	const chunks: Uint8Array[] = []
	try {
		while (true) {
			signal?.throwIfAborted()
			const { done, value } = await reader.read()
			if (done) break
			size += value.byteLength
			if (size > MAX_OUTPUT_BYTES * 2) throw new Error('AI output exceeds 2 MiB')
			chunks.push(value)
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} finally {
		await reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}
