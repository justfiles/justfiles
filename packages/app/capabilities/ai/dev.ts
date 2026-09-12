import { CapabilityError } from '../index.ts'
import { agentResolver } from './dev-agent.ts'
import {
	type AiBackend,
	type Deps,
	deps,
	findBackends,
	formatList,
	type GenerateText,
	resolveDevAi
} from './dev-text.ts'
import { aiCapability } from './host.ts'
import { publicFetch } from './node.ts'

export { type AiBackend, type GenerateText, resolveDevAi } from './dev-text.ts'

type Declared = Record<string, { id: string; scopes: readonly string[] }>

export function devAiCapability(
	generate: GenerateText,
	agent?: Parameters<typeof aiCapability>[0]['agent']
) {
	return aiCapability({
		agent,
		generate: async (input) => {
			try {
				return await generate(input)
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
): Promise<{ capability?: ReturnType<typeof devAiCapability>; message?: string }> {
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
	const agent = agentResolver(backend, use)
	return {
		capability: devAiCapability(resolved.generate, { ...agent, fetch: publicFetch }),
		message: `ai: ${resolved.name}`
	}
}
