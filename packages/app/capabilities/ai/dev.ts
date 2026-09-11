import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { CapabilityError, implementCapability } from '../index.ts'
import type { Capability } from '../types.ts'
import { ai } from './index.ts'

export type GenerateText = (input: {
	system: string
	prompt: string
	temperature?: number
	maxTokens?: number
}) => Promise<string>

export type AiBackend = GenerateText | 'pi-cli' | 'claude-cli' | 'codex-cli' | (string & {})

type Deps = {
	env: NodeJS.ProcessEnv
	which: (command: string, env: NodeJS.ProcessEnv) => boolean
	fetch: typeof globalThis.fetch
	spawn: typeof nodeSpawn
}

type Resolved = { name: string; generate: GenerateText }
type Declared = Record<string, { id: string; scopes: readonly string[] }>

const CLI = {
	'pi-cli': 'pi',
	'claude-cli': 'claude',
	'codex-cli': 'codex'
} as const

const LOCAL_SERVERS = ['http://localhost:11434/v1', 'http://localhost:1234/v1'] as const

const deps: Deps = {
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

export function devAiCapability(generate: GenerateText): Capability {
	return implementCapability(ai, {
		runAgent: () => {
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai', 'runAgent')
		},
		cancelAgent: () => {
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai', 'cancelAgent')
		},
		generateText: async (ctx, input) => {
			if (!input || typeof input.prompt !== 'string')
				throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'generateText')
			if (input.context !== undefined) {
				if (input.context !== 'learning')
					throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'generateText')
				if (!ctx.scopes.includes('context:learning'))
					throw new CapabilityError('CAPABILITY_DENIED', 'ai', 'generateText')
			}
			try {
				return {
					text: await generate({
						system: typeof input.system === 'string' ? input.system : '',
						prompt: input.prompt,
						temperature: input.temperature,
						maxTokens: input.maxTokens
					})
				}
			} catch (cause) {
				const error = new CapabilityError('CAPABILITY_FAILED', 'ai', 'generateText')
				error.message = cause instanceof Error ? cause.message : String(cause)
				throw error
			}
		}
	})
}

export async function devAiForApp(
	appId: string,
	declared: Declared,
	backend: AiBackend | undefined,
	use: Deps = deps
): Promise<{ capability?: Capability; message?: string }> {
	if (!Object.values(declared).some(({ id }) => id === 'ai')) return {}
	if (backend === undefined) {
		const found = await findBackends(use)
		const detail = found.length
			? `Found ${formatList(found)}.`
			: 'Found no supported local backend.'
		return {
			message: `ai: \`${appId}\` declares the \`ai\` capability but no dev backend is configured.\n    ${detail} Add \`devAi()\` to the plugins in vite.config.ts.`
		}
	}
	const resolved = await resolveDevAi(backend, use)
	if (!resolved)
		return {
			message:
				'ai: no supported local backend found. Install pi, Claude Code, Codex, or start Ollama or LM Studio.'
		}
	return { capability: devAiCapability(resolved.generate), message: `ai: ${resolved.name}` }
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

function run(use: Deps, command: string, args: string[], input: string): Promise<string> {
	return new Promise((done, fail) => {
		const child = use.spawn(command, args, { env: use.env, stdio: 'pipe' })
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk: string) => (stdout += chunk))
		child.stderr.on('data', (chunk: string) => (stderr += chunk))
		child.on('error', fail)
		child.stdin.on('error', fail)
		child.on('close', (code) => {
			if (code === 0) done(stdout.trim())
			else fail(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
		})
		child.stdin.end(input)
	})
}

function openAi(
	baseUrl: string,
	fetch: typeof globalThis.fetch,
	knownModel?: string
): GenerateText {
	let model = knownModel
	return async ({ system, prompt, temperature, maxTokens }) => {
		model ??= await readModel(baseUrl, fetch)
		const response = await fetch(endpoint(baseUrl, 'chat/completions'), {
			method: 'POST',
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
		const body = (await response.json()) as {
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
	const body = (await response.json()) as { data?: { id?: unknown }[] }
	const model = body.data?.[0]?.id
	if (typeof model !== 'string' || model === '') throw new Error('AI backend returned no models')
	return model
}

async function findBackends(use: Deps): Promise<string[]> {
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

function isHttpUrl(value: string): boolean {
	try {
		return ['http:', 'https:'].includes(new URL(value).protocol)
	} catch {
		return false
	}
}

function endpoint(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/${path}`
}

function formatList(values: string[]): string {
	const quoted = values.map((value) => `\`${value}\``)
	if (quoted.length < 2) return quoted[0] ?? ''
	return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}
