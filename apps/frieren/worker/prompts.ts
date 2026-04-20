import DEFAULT_SETUP from './prompts/default-setup.md?raw'
import FINAL_ANSWER_ONLY from './prompts/final-answer-only.md?raw'
import NOTE_TAKING from './prompts/note-taking.md?raw'
import REFLECTION_SYSTEM from './prompts/reflection-system.md?raw'
import SOUL_GENERATION from './prompts/soul-generation.md?raw'

export function systemPrompt(...parts: string[]) {
	return { add, build }

	function build() {
		return parts.join('\n')
	}

	/**
	 * add a section
	 */
	function add(...content: string[]) {
		parts.push('\n', ...content)
	}
}

export type SoulGenerationInput = {
	agentName: string
	agentGender?: string
	archetype: 'teacher' | 'companion' | 'assistant'
	userAge?: number
	userGender?: string
}

export const SOUL_GENERATION_PROMPT = SOUL_GENERATION

export const DEFAULT_SETUP_PROMPT = DEFAULT_SETUP

export const FINAL_ANSWER_ONLY_INSTRUCTION = FINAL_ANSWER_ONLY

export const REFLECTION_SYSTEM_PROMPT = REFLECTION_SYSTEM

export const NOTE_TAKING_PROMPT = NOTE_TAKING
