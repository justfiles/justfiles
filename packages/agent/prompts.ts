import FILESYSTEM from './prompts/filesystem.md?raw'
import FINAL_ANSWER_ONLY from './prompts/final-answer-only.md?raw'
import MEMORY_CONSOLIDATION from './prompts/memory-consolidation.md?raw'
import NOTE_TAKING from './prompts/note-taking.md?raw'
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
	// The nature picked at the summoning, which seeds the FIRST draft only. Absent on a
	// rewrite: nothing records a nature afterwards, because the prose is the character.
	archetype?: 'teacher' | 'companion' | 'assistant'
	userAge?: number
	userGender?: string
}

export const SOUL_GENERATION_PROMPT = SOUL_GENERATION

export const FINAL_ANSWER_ONLY_INSTRUCTION = FINAL_ANSWER_ONLY

export const NOTE_TAKING_PROMPT = NOTE_TAKING

export const MEMORY_CONSOLIDATION_PROMPT = MEMORY_CONSOLIDATION

// The `# your filesystem` block: where the agent is and what each path is for. Byte-stable
// across turns (no live data) so it sits in the cached prompt prefix. The one variation is
// the `os` command, which exists only when the host supplies an `osState` port — the same
// way the docs block exists only when a host supplies `readDoc`.
export function filesystemPrompt({ os }: { os: boolean }): string {
	if (!os) return FILESYSTEM
	return `${FILESYSTEM}\nFor what the user is looking at right now, run \`os windows\`.`
}
