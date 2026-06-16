// @justfiles/agent — the host-agnostic agent: the pi-agent-core runtime loop
// (sessions + compaction + memory), its fs/fetch/search/takeNote tools, the bash
// command registry + commands, and the agent↔kernel `AppController` bridge. The
// host injects the model (via `createAgent` / `text`) and an `AppController`;
// the persona/memory are data on the Volume (`/system/soul.md`, …).

export type { AppController } from './bash/commands/app.ts'
export { createAppCommand } from './bash/commands/app.ts'
export { cp, mv, rm } from './bash/commands/fs.ts'
export { createNowCommand } from './bash/commands/now.ts'
export { defineCommand } from './bash/define.ts'
export { createBashTool } from './bash/index.ts'
export { type Command, CommandRegistry, type CommandResult } from './bash/registry.ts'
export type { CompactionSettings } from './compaction.ts'
export { createAgent } from './llm.agent.ts'
export { type LLMText, text } from './llm.text.ts'
export { parseFrontmatter } from './markdown.ts'
export { SOUL_GENERATION_PROMPT, type SoulGenerationInput } from './prompts.ts'
export { type Runtime, runtime } from './runtime.ts'
export type { SessionEntry } from './session.manager.ts'
export {
	DEFAULT_TIMEZONE,
	isoToTimezone,
	nextFourAmInTimezone,
	resolveTimezone
} from './timezone.ts'
export {
	createAskUserTool,
	createFetchTool,
	createFsTools,
	createSearchTool,
	createTakeNoteTool,
	type FsToolset
} from './tools.ts'
