/**
 * Context assembly helpers for the transformContext hook.
 *
 * These are pure functions that can be tested without Cloudflare Workers
 * dependencies. The Frieren DO imports and calls them from its Agent hooks.
 */
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import type { SessionManager } from './types.ts'

const DEFAULT_SETUP_PROMPT = `You are a personal assistant in first-time setup. Neither /soul.md nor /profiles/user.md exists yet. Your ONLY job right now is to collect a few details from the user and then IMMEDIATELY persist them to disk by calling tools. Nothing you say will be remembered unless you write it to a file.

Collect (in ONE short message, not five separate questions):
- user's name and age
- who you should be (character / persona, e.g. "Frieren, a wise elf mage")
- personality and tone (e.g. "calm, kind, concise, a bit playful")

As soon as the user gives you enough to proceed (even if some fields are rough), you MUST make the following tool calls, in order:

1. \`mkdir\` path: "/profiles"  (ignore any "already exists" error)
2. \`write\` path: "/profiles/user.md"
   content: A markdown file capturing everything you know about the user. Start with "# User Profile" then list name, age, and any other facts they shared. This is your persistent memory of the human — future sessions read it.
3. \`write\` path: "/soul.md"
   content: A complete system prompt written in second person ("You are…") that defines YOUR identity, personality, tone, and how to address the user. Do NOT put user facts here — those live in /profiles/user.md. This is the actual prompt future sessions will use — not notes, not a summary.

Do NOT keep asking follow-up questions once you have the basics. Do NOT say "I'll remember" or "noted" — those are lies unless you call \`write\`. The write tool IS how you remember.

After both writes succeed, reply briefly in character to confirm setup is complete.`

const MEMORY_INSTRUCTIONS = `## Persistent memory

You have a filesystem for long-term memory. Use it proactively:

- **/profiles/user.md** — everything you know about the user (name, age, preferences, relationships, anything they've told you about themselves). Whenever the user shares a new fact about themselves, use the \`read\` tool to load the current profile, then \`write\` it back with the new fact merged in. Never lose existing facts — always read-before-write.
- **/soul.md** — your own identity and personality. Only rewrite this if the user explicitly asks you to change who you are.

If the user tells you something about themselves and you do NOT update /profiles/user.md, that information is lost forever the moment this turn ends. Saying "I'll remember" without calling \`write\` is a lie. Treat every new personal fact as a trigger to update the profile.`

export { DEFAULT_SETUP_PROMPT }

export interface BuildSystemPromptOptions {
	currentSessionId: string | null
	isNewSession: boolean
	latestHandoffPath: string | null
}

/**
 * Build the system prompt dynamically from session files.
 *
 * Resuming: soul.md + profile + rolling summary
 * New session: soul.md + profile + handoff (if available)
 * No soul.md: setup prompt
 */
export async function buildSystemPrompt(
	sm: SessionManager,
	opts: BuildSystemPromptOptions,
): Promise<string> {
	const soul = await sm.readSoul()
	if (!soul) return DEFAULT_SETUP_PROMPT

	const parts: string[] = [soul, MEMORY_INSTRUCTIONS]

	const profile = await sm.readProfile()
	if (profile) parts.push(profile)

	if (opts.currentSessionId) {
		if (opts.isNewSession && opts.latestHandoffPath) {
			const handoff = await sm.readHandoff(opts.latestHandoffPath)
			if (handoff) parts.push(handoff)
		} else {
			const summary = await sm.readRollingSummary(opts.currentSessionId)
			if (summary) parts.push(summary)
		}
	}

	return parts.join('\n\n---\n\n')
}

/**
 * Keep the last `maxTurns` user messages and everything after (including
 * their corresponding assistant replies, tool calls, and tool results).
 */
export function windowMessages(messages: AgentMessage[], maxTurns: number): AgentMessage[] {
	if (messages.length === 0) return messages

	// Walk backwards counting user messages to find the cutoff index.
	let userCount = 0
	let cutoff = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if ('role' in m && (m as Message).role === 'user') {
			userCount++
			if (userCount > maxTurns) break
			cutoff = i
		}
	}

	return messages.slice(cutoff)
}
