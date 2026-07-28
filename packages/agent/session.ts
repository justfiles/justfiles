import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { Capabilities } from '@justfiles/app/capabilities'
import type { Channel, Route } from '@justfiles/app/capabilities/notify'
import type { Volume } from '@justfiles/fs'
import {
	type Assistant,
	consolidateMemory,
	createAssistant,
	type PromptSource
} from './assistant.ts'
import { type CapabilityToolSet, capabilityTools } from './capability-tools.ts'
import type { CompactionSettings } from './compaction.ts'
import { stripExpressions } from './expression.ts'
import { APPS_PROMPT, type AppController, createAppCommand } from './justbash/app.ts'
import { createJustBashTool } from './justbash/index.ts'
import { createAgent } from './llm.agent.ts'
import { text as createText, type LLMText } from './llm.text.ts'
import type { AgentBackend } from './llm.ts'
import type { SessionEntry } from './session.manager.ts'
import { listSkills, type SkillMeta } from './skills.ts'
import { DEFAULT_TIMEZONE, nextFourAmInTimezone } from './timezone.ts'
import { createAskUserTool, createFetchTool, createSearchTool } from './tools/index.ts'

// The agent PRODUCT: one correct assembly of the pi-agent-core loop + our tools + the
// turn runner + error classification + notifications. A host injects its ports (a Volume,
// a credential-sealed backend, an app bridge, a notify channel, a docs reader) and gets a
// ready-to-drive session — the composition that each host used to hand-assemble (and drift
// on) now lives here. Skills/sessions are semantic methods; the host maps its own slash
// commands onto them (the agent has NO `command` concept — see `newSession`/`applySkill`).
export interface AgentSessionOptions {
	volume: Volume
	// Static config OR a resolver called each turn — a rotating OAuth token changes
	// `backend.revision`, and the session rebuilds transparently (lossless: the conversation
	// lives on the Volume, which the fresh build reloads). A build failure clears the cache,
	// so a sign-in after an offline start retries on the next use.
	backend: AgentBackend | (() => Promise<AgentBackend>)
	// Drives apps over the host's kernel → adds the `app` shell command. This is HOW the agent
	// reaches account-backed capabilities (email/calendar/…): through apps, not dedicated
	// tools. Omit for no apps.
	apps?: AppController
	// Capability-provided agent tools (Step 3.5): the host's capability invoke plus the
	// descriptor sets to expose. Each tool invokes as the privileged agent actor.
	capabilities?: { invoke: Capabilities['invoke']; tools: readonly CapabilityToolSet[] }
	// A host channel for turn pings + classified errors (banner/toast/web-push). Omit to
	// stay silent; the transcript still updates via `subscribe`.
	notify?: Channel
	// Notification banner title (host branding). Only used when `notify` is set.
	title?: string
	// Reads a doc body by id (disk on native, asset fetch on web) → the `read_doc` tool +
	// the docs system-prompt block. Omit to disable docs.
	readDoc?: (id: string) => Promise<string>
	// The user's timezone → the "current time" prompt block + `nextMaintenanceAt`.
	timezone?: () => Promise<string> | string
	compaction?: CompactionSettings
	// Ask the agent for a per-sentence expression tag (`[pleased]…`) — see expression.ts.
	// Only for a host that strips them before display; frieren maps them to avatar faces.
	expressions?: boolean
}

// One broad event stream the UI subscribes to — busy/transcript/error — so every open
// surface (a second tab, the native launcher) converges with no polling. `newSession`
// re-emits an empty transcript, which is all a UI needs to reset.
export type SessionEvent =
	| { type: 'busy'; value: boolean }
	| { type: 'transcript'; entries: SessionEntry[] }
	| { type: 'error'; message: string; route?: Route }

// A per-turn observer of the RAW agent event stream (token/tool deltas), for a host that
// renders live streaming (frieren) rather than transcript snapshots (the Mac app). Subscribed
// only for the turn's duration (see `prompt`); matches the Assistant's listener shape.
export type TurnListener = (event: AgentEvent, signal: AbortSignal) => void

export interface AgentSession {
	// --- conversation ---
	// `onEvent` streams the raw agent events (token/tool deltas) for THIS turn only — a host
	// that renders live streaming passes it; one that renders transcript snapshots omits it and
	// reads `subscribe` instead. Either way the turn's outcome also lands on `subscribe`.
	prompt(message: string, source?: PromptSource, onEvent?: TurnListener): Promise<string>
	abort(): void
	history(): Promise<readonly SessionEntry[]>
	subscribe(fn: (event: SessionEvent) => void): () => void
	// --- semantic actions a UI slash-command maps to ---
	newSession(): Promise<void>
	listSkills(): Promise<SkillMeta[]>
	applySkill(id: string): Promise<string>
	// --- maintenance (cron) & introspection ---
	runMaintenance(): Promise<void>
	nextMaintenanceAt(now: Date): Promise<number | null>
	systemPrompt(): Promise<string>
}

const DEFAULT_COMPACTION: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000
}

// A multiple-choice question the agent posed via `ask_user`, captured for the running turn
// so the turn can swap its notification ping from `info` to `question` once the turn ends.
interface PendingQuestion {
	question: string
	options: string[]
}

// The lazily-built runtime: the composed Assistant, the text helper (for maintenance), and
// a read-and-clear for the pending `ask_user` question.
interface Built {
	assistant: Assistant
	text: LLMText
	takePending: () => PendingQuestion | null
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
	const { volume, apps, notify, readDoc, timezone } = options
	const title = options.title ?? 'Assistant'
	const compaction = options.compaction ?? DEFAULT_COMPACTION
	const backend = options.backend
	const resolveBackend: () => Promise<AgentBackend> =
		typeof backend === 'function' ? backend : async () => backend

	const listeners = new Set<(event: SessionEvent) => void>()

	// Re-resolve the backend on every use and cache the built runtime keyed on `model +
	// revision`, so a model switch or a token refresh takes effect on the next turn without a
	// restart. The per-key promise dedupes concurrent builds; a failure clears the cache.
	let active: { key: string; built: Promise<Built> } | null = null

	return {
		prompt: (message, source, onEvent) =>
			runTurn((assistant) => assistant.prompt(message, source), onEvent),
		abort,
		history,
		subscribe,
		newSession,
		listSkills: () => listSkills(volume),
		applySkill: (id) => runTurn((assistant) => assistant.applySkill(id)),
		runMaintenance,
		nextMaintenanceAt,
		systemPrompt
	}

	async function getBuilt(): Promise<Built> {
		const llm = await resolveBackend()
		const key = `${llm.model.id} ${llm.revision}`
		if (!active || active.key !== key) {
			const built = build(llm).catch((error) => {
				if (active?.key === key) active = null
				throw error
			})
			active = { key, built }
		}
		return active.built
	}

	async function build(llm: AgentBackend): Promise<Built> {
		const text = createText(llm)
		const assistant = await createAssistant({
			volume,
			agent: createAgent(llm),
			text,
			compaction,
			getTimezone: timezone,
			readDoc,
			appsPrompt: apps ? APPS_PROMPT : undefined,
			expressions: options.expressions
		})

		let pending: PendingQuestion | null = null
		const bash = createJustBashTool({
			volume,
			commands: apps ? [createAppCommand(apps)] : []
		})
		const askUser = createAskUserTool((question, opts) => {
			pending = { question, options: opts }
		})
		const capTools = options.capabilities
			? capabilityTools(options.capabilities.invoke, options.capabilities.tools, volume)
			: []
		assistant.addTools([bash, createFetchTool(), createSearchTool(), askUser, ...capTools])

		return {
			assistant,
			text,
			takePending: () => {
				const value = pending
				pending = null
				return value
			}
		}
	}

	function subscribe(fn: (event: SessionEvent) => void): () => void {
		listeners.add(fn)
		return () => listeners.delete(fn)
	}

	function emit(event: SessionEvent): void {
		for (const fn of listeners) fn(event)
	}

	// Run one turn on the shared session: broadcast busy + the resulting transcript (or a
	// classified error) to every subscriber and ping the notification channel. `ask_user`
	// ends a turn with a question that already lands in the session (the transcript renders
	// it); we only swap the banner ping to `question`. Never rejects — a failed turn surfaces
	// through the event stream + notification, so a host can `void session.prompt(...)`.
	async function runTurn(
		run: (assistant: Assistant) => Promise<string>,
		onEvent?: TurnListener
	): Promise<string> {
		emit({ type: 'busy', value: true })
		try {
			const built = await getBuilt()
			// Stream the raw turn events to a streaming host for this turn only; unsubscribed in
			// the inner `finally` so events never leak across turns.
			const unsubscribe = onEvent ? built.assistant.subscribe(onEvent) : undefined
			built.takePending() // drop any stale question before the turn
			try {
				const answer = await run(built.assistant)
				const asked = built.takePending()
				emit({ type: 'transcript', entries: [...(await built.assistant.history())] })
				ping(asked ? 'question' : 'info', asked ? asked.question : answer, { kind: 'chat' })
				return answer
			} finally {
				unsubscribe?.()
			}
		} catch (error) {
			const failure = classifyFailure(error)
			console.error('[agent] turn failed:', error)
			emit({ type: 'error', message: failure.body, route: failure.route })
			ping('error', failure.body, failure.route)
			return ''
		} finally {
			emit({ type: 'busy', value: false })
		}
	}

	// Cancel the in-flight turn, leaving the session intact. Guards on the cached runtime so
	// an abort never builds a runtime just to cancel nothing.
	function abort(): void {
		if (!active) return
		void active.built
			.then(({ assistant }) => assistant.abort())
			.catch((error) => console.error('[agent] abort failed:', error))
	}

	// The transcript for a connect snapshot; empty when the runtime can't build (no backend),
	// so a UI shows an empty transcript rather than erroring.
	async function history(): Promise<readonly SessionEntry[]> {
		try {
			return await (await getBuilt()).assistant.history()
		} catch {
			return []
		}
	}

	// Start a fresh session and reset every subscriber (an empty transcript). Best-effort: a
	// build failure still emits the empty transcript so the UI clears.
	async function newSession(): Promise<void> {
		try {
			const built = await getBuilt()
			built.takePending()
			await built.assistant.newSession()
		} catch (error) {
			console.error('[agent] newSession failed:', error)
		}
		emit({ type: 'transcript', entries: [] })
	}

	// Roll yesterday's daily notes into permanent memory. No-op when the runtime can't build.
	async function runMaintenance(): Promise<void> {
		try {
			await consolidateMemory(volume, (await getBuilt()).text)
		} catch (error) {
			console.error('[agent] maintenance failed:', error)
		}
	}

	// When the host's cron should next run maintenance (4am in the user's timezone), so it can
	// schedule its alarm. Independent of the backend.
	async function nextMaintenanceAt(now: Date): Promise<number | null> {
		const tz = (timezone ? await timezone() : DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE
		return nextFourAmInTimezone(now, tz)
	}

	async function systemPrompt(): Promise<string> {
		return (await getBuilt()).assistant.systemPrompt()
	}

	function ping(kind: 'info' | 'error' | 'question', body: string, route: Route): void {
		if (!notify) return
		notify({
			id: crypto.randomUUID(),
			source: 'agent',
			kind,
			title,
			// A notification is read by a human, so a host that asked for expression tags has
			// them taken off here. A host that never asked keeps its text verbatim: the tag
			// vocabulary is ordinary English, so stripping unconditionally would delete a
			// legitimate `[thinking]` from a reply nobody asked to be tagged.
			body: summarize(options.expressions ? stripExpressions(body).text : body),
			threadId: 'agent',
			route
		})
	}
}

// Classify a failed turn into a user-facing message + a fix-it route. pi-ai surfaces provider
// failures as plain `Error` messages (not typed codes), so we match on the text: an
// expired/unauthorised token → reconnect in Settings → Accounts; a blown context window / rate
// limit → back to chat (start fresh); anything else → a generic error that opens chat. Stingy
// by design — two actionable cases, then a catch-all.
export function classifyFailure(error: unknown): { body: string; route: Route } {
	const raw = error instanceof Error ? error.message : String(error)
	if (/no ai (backend|provider)|ai is turned off|enable an ai provider/i.test(raw)) {
		return {
			body: 'No AI is turned on. Enable an AI provider in Settings → Accounts to start chatting.',
			route: { kind: 'settings', pane: 'accounts' }
		}
	}
	if (/\b401\b|unauthor|invalid[_ ]?api[_ ]?key|authentic|expired|account[_ -]?id/i.test(raw)) {
		return {
			body: 'Your sign-in expired. Reconnect in Settings → Accounts.',
			route: { kind: 'settings', pane: 'accounts' }
		}
	}
	if (
		/context[_ ]?(length|window)|token limit|maximum context|too many tokens|\b429\b|rate limit/i.test(
			raw
		)
	) {
		return {
			body: 'The model hit its token limit. Start a new chat or shorten your request.',
			route: { kind: 'chat' }
		}
	}
	return { body: `Agent error: ${raw}`, route: { kind: 'chat' } }
}

// Trim an answer to a banner-sized one-liner: first line, capped, ellipsised.
function summarize(value: string): string {
	const line = value.trim().split('\n')[0] ?? ''
	return line.length > 140 ? `${line.slice(0, 139)}…` : line
}
