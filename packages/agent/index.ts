// @justfiles/agent — the host-agnostic agent: the pi-agent-core runtime loop
// (sessions + compaction + memory), its fetch/search/takeNote/ask_user tools, the
// just-bash shell over the Volume (plus a custom `app` command), and the
// agent↔kernel `AppController` bridge. The host injects the model (via
// `createAgent` / `text`) and an `AppController`; the persona/memory are data on
// the Volume (`/system/soul.md`, …).

export type { Agent } from '@mariozechner/pi-agent-core'
export {
	type Assistant,
	consolidateMemory,
	createAssistant,
	type PromptSource
} from './assistant.ts'
export type { CompactionSettings } from './compaction.ts'
export type { AppController } from './justbash/app.ts'
// The `app` command — drives apps over the kernel — as a just-bash ShellCommand.
export { createAppCommand as createAppShellCommand } from './justbash/app.ts'
export {
	createJustBashTool,
	type JustBashToolOptions,
	type ShellCommand
} from './justbash/index.ts'
export { volumeFs } from './justbash/volume-fs.ts'
export { createAgent } from './llm.agent.ts'
export { type LLMText, text } from './llm.text.ts'
export { type AgentBackend, apiKeyBackend, type LLMConfig } from './llm.ts'
export { parseFrontmatter } from './markdown.ts'
export { SOUL_GENERATION_PROMPT, type SoulGenerationInput } from './prompts.ts'
export type { SessionEntry } from './session.manager.ts'
// The agent product: one composed session (turn runner + tools + notify + classified
// errors). Built on top of createAssistant; hosts should prefer this over hand-assembly.
export {
	type AgentSession,
	type AgentSessionOptions,
	classifyFailure,
	createAgentSession,
	type SessionEvent,
	type TurnListener
} from './session.ts'
export { listSkills, type SkillMeta } from './skills.ts'
export {
	DEFAULT_TIMEZONE,
	isoToTimezone,
	nextFourAmInTimezone,
	resolveTimezone
} from './timezone.ts'
export {
	createAskUserTool,
	createFetchTool,
	createSearchTool,
	createTakeNoteTool
} from './tools/index.ts'
