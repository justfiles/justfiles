/**
 * Slash commands — the user-typed `/` menu. A command is identity + description:
 * a host renders a filterable menu from `listCommands()` and dispatches by name.
 * There is NO parsing — the menu filters this list and runs the selected command
 * by id; commands take no inline arguments.
 *
 * Two kinds share one list:
 *   - built-in host actions (e.g. /new) — the host runs these directly;
 *   - skills — each skill id is a command whose body is submitted as a turn
 *     (deterministic prompt-expansion, like Claude Code custom commands), so the
 *     model follows it without having to choose `read_skill` first.
 */

import type { SkillRegistry } from './skills.ts'

export interface CommandMeta {
	name: string
	description: string
	// 'builtin' → the host runs it; 'skill' → expand the skill body into a turn.
	kind: 'builtin' | 'skill'
}

export const BUILTIN_COMMANDS: readonly CommandMeta[] = [
	{ name: 'new', description: 'Start a fresh chat session', kind: 'builtin' }
]

// The full catalogue: built-ins first, then every skill as a `/id` command. A skill
// whose id shadows a built-in name is dropped (the built-in wins).
export async function listCommands(skills: SkillRegistry): Promise<CommandMeta[]> {
	const taken = new Set(BUILTIN_COMMANDS.map((command) => command.name))
	const skillCommands = (await skills.list())
		.filter((skill) => !taken.has(skill.id))
		.map(
			(skill): CommandMeta => ({ name: skill.id, description: skill.description, kind: 'skill' })
		)
	return [...BUILTIN_COMMANDS, ...skillCommands]
}
