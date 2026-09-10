import { text } from './llm.text.ts'
import type { AgentBackend } from './llm.ts'
import { SOUL_GENERATION_PROMPT, type SoulGenerationInput } from './prompts.ts'

interface GeneratedSoul {
	body: string
	firstWords?: string
}

const FIRST_WORDS_PROMPT =
	'Return one short opening sentence spoken by this agent. No label, explanation, or quotation marks.'

export async function generateSoul(
	backend: AgentBackend,
	input: SoulGenerationInput,
	options: { firstWords?: boolean } = {}
): Promise<GeneratedSoul> {
	const facts = [`agent name: ${input.agentName}`]
	if (input.archetype) facts.push(`archetype: ${input.archetype}`)
	if (input.agentGender) facts.push(`agent gender: ${input.agentGender}`)
	if (input.userAge !== undefined) facts.push(`user age: ${input.userAge}`)
	if (input.userGender) facts.push(`user gender: ${input.userGender}`)
	const context = facts.join('\n')
	const llm = text(backend)
	const body = await llm.gen(SOUL_GENERATION_PROMPT, context)
	if (!options.firstWords) return { body }
	return { body, firstWords: await llm.gen(FIRST_WORDS_PROMPT, `${context}\n\nsoul:\n${body}`) }
}
