// @justfiles/agent — the host-agnostic agent PRODUCT. `createAgentSession` composes the
// pi-agent-core turn runner, its tools (a just-bash shell over the Volume plus fetch/
// search/ask_user and an `app` command that drives apps over the kernel), compaction +
// memory, notify pings, and classified errors. A host injects ports (volume, backend,
// apps, notify, readDoc, timezone); the persona/memory are data on the Volume
// (`/system/agents/main/soul.md`, …). The tool/assistant/shell primitives are internal — hosts
// declare what they have and let the product assemble the rest.

// The host-side `ai` capability: scope-gated, purpose-scoped context composition
// over a low-level `generate` fn (the learning-context projection is internal).
export { aiCapability, type GenerateText } from './ai.capability.ts'
// ── The seam a host implements: how apps are driven ─────────────────
export type { AppController } from './justbash/app.ts'
// Powers soul generation and the `ai` capability.
export { type LLMText, text } from './llm.text.ts'
// ── The credential/model seam + one-shot text generation ────────────
export { type AgentBackend, modelsBackend } from './llm.ts'
// ── Onboarding / maintenance building blocks (host-owned, for now) ──
// Soul generation and the daily-alarm timezone math still run in the host until they
// fold into product methods (generateSoul / nextMaintenanceAt).
export { parseFrontmatter } from './markdown.ts'
export { SOUL_GENERATION_PROMPT, type SoulGenerationInput } from './prompts.ts'
export type { ImageRef, SessionEntry } from './session.manager.ts'
// ── The agent product ──────────────────────────────────────────────
export {
	type AgentSession,
	type AgentSessionOptions,
	classifyFailure,
	createAgentSession,
	type SessionEvent
} from './session.ts'
// The UI builds its "/" menu from session.listSkills() — a skill, never a "command".
export type { SkillMeta } from './skills.ts'
export { nextFourAmInTimezone, resolveTimezone } from './timezone.ts'
