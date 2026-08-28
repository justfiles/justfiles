import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { Capabilities } from '@justfiles/app/capabilities'
import type { Channel, Route } from '@justfiles/app/capabilities/notify'
import type { Volume } from '@justfiles/fs'
import { readActivityDetail } from './activity-detail.ts'
import { PROFILE_PATH, readAgentName, SOUL_PATH } from './agent-defaults.ts'
import { type Assistant, consolidateMemory, createAssistant } from './assistant.ts'
import { type CapabilityToolSet, capabilityTools } from './capability-tools.ts'
import type { CompactionSettings } from './compaction.ts'
import { stripExpressions } from './expression.ts'
import { APPS_PROMPT, type AppController, createAppCommand } from './justbash/app.ts'
import { createJustBashTool } from './justbash/index.ts'
import { createOsCommand, type OsState } from './justbash/os.ts'
import { createAgent } from './llm.agent.ts'
import { text as createText, type LLMText } from './llm.text.ts'
import type { AgentBackend } from './llm.ts'
import { currentSession, type SessionEntry, session } from './session.manager.ts'
import { listSkills, type SkillMeta } from './skills.ts'
import { DEFAULT_TIMEZONE, nextFourAmInTimezone } from './timezone.ts'
import { createAskUserTool, createFetchTool, createSearchTool } from './tools/index.ts'
import type { ActivityDetailResult } from './transcript.ts'

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
	// A read-only projection of the host's shell (which windows are open, which is focused)
	// → adds the `os` command. The agent never parses `/system/os-state.json`: that file is a
	// persistence artifact, this is the one fact it can act on. Omit for a host with no shell.
	osState?: OsState
	// Capability-provided agent tools (Step 3.5): the host's capability invoke plus the
	// descriptor sets to expose. Each tool invokes as the privileged agent actor.
	capabilities?: { invoke: Capabilities['invoke']; tools: readonly CapabilityToolSet[] }
	// A host channel for turn pings + classified errors (banner/toast/web-push). Omit to
	// stay silent; the transcript still updates via `subscribe`.
	notify?: Channel
	// Notification banner title (host branding). Only used when `notify` is set. Omit it to
	// get the agent's own name from the soul, kept current as the soul changes — which is
	// what both hosts want; pass one only to override that.
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

export type SessionStatus =
	| { state: 'idle' }
	| {
			state: 'thinking' | 'calling_tool' | 'responding'
			detail?: AgentEvent
	  }

export interface SessionSnapshot {
	history: readonly SessionEntry[]
	status: SessionStatus
}

export type SessionUpdate =
	| { type: 'items'; items: readonly SessionEntry[] }
	| { type: 'snapshot'; snapshot: SessionSnapshot }
	| {
			type: 'status'
			status: SessionStatus
			error?: { message: string; route?: Route }
	  }

export type StartTurnResult = { accepted: true; done: Promise<string> } | { accepted: false }

export interface AgentSession {
	// --- conversation ---
	start(message: string): StartTurnResult
	abort(): boolean
	snapshot(): Promise<SessionSnapshot>
	activityDetail(detailId: string): Promise<ActivityDetailResult>
	subscribe(fn: (update: SessionUpdate) => void): () => void
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

interface RunningTurn {
	aborted: boolean
	done: Promise<string> | null
}

// The lazily-built runtime: the composed Assistant, the text helper (for maintenance), and
// a read-and-clear for the pending `ask_user` question.
interface Built {
	assistant: Assistant
	text: LLMText
	title: string
	takePending: () => PendingQuestion | null
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
	return makeSession(options, { agentId: 'main', kind: 'main' })
}

export function createAppAgentSession(
	options: AgentSessionOptions,
	agentId: string,
	appContext: () => Promise<string>
): AgentSession {
	return makeSession(options, { agentId, kind: 'app', appContext })
}

interface SessionTarget {
	agentId: string
	kind: 'main' | 'app'
	appContext?: () => Promise<string>
}

function makeSession(options: AgentSessionOptions, target: SessionTarget): AgentSession {
	const { volume, apps, notify, readDoc, timezone } = options
	// The banner name. Re-read from the soul on every build (see below) unless the host
	// insists on branding of its own, so a rename reaches notifications too.
	let title = options.title ?? 'Assistant'
	const compaction = options.compaction ?? DEFAULT_COMPACTION
	const backend = options.backend
	const resolveBackend: () => Promise<AgentBackend> =
		typeof backend === 'function' ? backend : async () => backend

	const listeners = new Set<(update: SessionUpdate) => void>()

	// Re-resolve the backend on every use and cache the built runtime keyed on `model +
	// revision`, so a model switch or a token refresh takes effect on the next turn without a
	// restart. The per-key promise dedupes concurrent builds; a failure clears the cache.
	//
	// `revision` is this cache's own clock, private to the session: the identity watches below
	// bump it, and a build that started before a bump can never become active — it is simply
	// retried against the files as they are now. Nothing outside sees it; it is not a lifetime,
	// a fence, or a token a caller has to carry.
	let revision = 0
	let active: { key: string; revision: number; built: Promise<Built> } | null = null
	let watching: Promise<void> | null = null
	let running: RunningTurn | null = null
	let resetting: Promise<void> | null = null
	let historyReader: Assistant | null = null
	let history: readonly SessionEntry[] = []
	let historyLoaded = false
	let status: SessionStatus = { state: 'idle' }

	// THE IDENTITY FILES ARE READ WHEN THE RUNTIME IS BUILT — the soul and the user profile
	// become the system prompt, the agent's name becomes the banner title — and they change
	// under a live session: naming your agent is a Settings pane on every host now, and a
	// soul edited on one device syncs to the others. So watch them and drop the build; the
	// next turn reads them again, losslessly (the conversation lives on the Volume too).
	//
	// This belongs HERE, not in each host: every host memoises a session, so every host
	// would otherwise have to remember to invalidate it, and the one that forgets keeps
	// answering as the agent the user just renamed. Sessions live as long as their process,
	// so the watches are never torn down. Registration is part of the lazy build: constructing
	// a session must not touch storage before its host's migration barrier has completed.

	return {
		start: (message) => startTurn((assistant) => assistant.prompt(message)),
		abort,
		snapshot,
		activityDetail,
		subscribe,
		newSession,
		listSkills: () => listSkills(volume),
		applySkill,
		runMaintenance,
		nextMaintenanceAt,
		systemPrompt
	}

	async function activityDetail(detailId: string): Promise<ActivityDetailResult> {
		if (historyReader) return historyReader.activityDetail(detailId)
		const current = await currentSession(volume, target.agentId)
		if (!current) return { status: 'expired' }
		const manager = session(volume, {
			agentId: target.agentId,
			sessionId: current.sessionId,
			startTs: current.startTs,
			deviceId: 'read0000'
		})
		return readActivityDetail(
			volume,
			target.agentId,
			current.sessionId,
			await manager.walkActiveBranch(),
			detailId
		)
	}

	async function getBuilt(): Promise<Built> {
		while (true) {
			const llm = await resolveBackend()
			const key = `${llm.model.id} ${llm.revision}`
			const at = revision
			let selected = active
			if (!selected || selected.key !== key || selected.revision !== at) {
				const built = build(llm)
				selected = { key, revision: at, built }
				active = selected
				void built.catch(() => {
					if (active === selected) active = null
				})
			}
			// Checked AFTER the await, on both paths: a watch that fired while this build ran
			// invalidated it, so neither its Assistant nor its failure may be handed back — the
			// loop reads the current files instead.
			try {
				const built = await selected.built
				if (selected.revision !== revision) continue
				title = built.title
				historyReader = built.assistant
				return built
			} catch (error) {
				if (selected.revision !== revision) continue
				throw error
			}
		}
	}

	async function build(llm: AgentBackend): Promise<Built> {
		await ensureWatching()
		// Read where the rest of the identity is read, so the watch above refreshes it too.
		const builtTitle = options.title ?? (await readAgentName(volume))
		const text = createText(llm)
		const assistant = await createAssistant({
			volume,
			agent: createAgent(llm),
			text,
			agentId: target.agentId,
			kind: target.kind,
			appContext: target.appContext,
			compaction,
			getTimezone: timezone,
			readDoc,
			appsPrompt: apps ? APPS_PROMPT : undefined,
			expressions: options.expressions,
			os: Boolean(options.osState),
			onEntriesAppended: publishItems
		})

		let pending: PendingQuestion | null = null
		const bash = createJustBashTool({
			volume,
			commands: [
				...(apps ? [createAppCommand(apps)] : []),
				...(options.osState ? [createOsCommand(options.osState)] : [])
			]
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
			title: builtTitle,
			takePending: () => {
				const value = pending
				pending = null
				return value
			}
		}
	}

	async function ensureWatching(): Promise<void> {
		watching ??= registerWatches().catch((error) => {
			watching = null
			throw error
		})
		return watching
	}

	async function registerWatches(): Promise<void> {
		const unwatch: (() => void)[] = []
		try {
			for (const path of [SOUL_PATH, PROFILE_PATH]) {
				unwatch.push(
					await volume.watch(path, () => {
						revision++
						active = null
					})
				)
			}
		} catch (error) {
			for (const stop of unwatch) stop()
			throw error
		}
	}

	function subscribe(fn: (update: SessionUpdate) => void): () => void {
		listeners.add(fn)
		return () => listeners.delete(fn)
	}

	function emit(update: SessionUpdate): void {
		for (const fn of listeners) fn(update)
	}

	function startTurn(run: (assistant: Assistant) => Promise<string>): StartTurnResult {
		if (running) return { accepted: false }
		const runState: RunningTurn = { aborted: false, done: null }
		running = runState
		status = { state: 'thinking' }
		emit({ type: 'status', status })
		const reset = resetting
		const done = Promise.resolve().then(async () => {
			if (reset) await reset
			return runTurn(runState, run)
		})
		runState.done = done
		return { accepted: true, done }
	}

	async function runTurn(
		state: RunningTurn,
		run: (assistant: Assistant) => Promise<string>
	): Promise<string> {
		let built: Built | null = null
		let failure: ReturnType<typeof classifyFailure> | undefined
		try {
			const ready = await getBuilt()
			built = ready
			if (state.aborted) return ''
			if (!historyLoaded) {
				history = await readHistory(ready)
				historyLoaded = true
			}
			const unsubscribe = ready.assistant.subscribe((event) => {
				if (running !== state) return
				status = eventStatus(event, status)
				emit({ type: 'status', status })
			})
			ready.takePending() // drop any stale question before the turn
			try {
				const answer = await run(ready.assistant)
				const asked = ready.takePending()
				if (state.aborted) return ''
				ping(asked ? 'question' : 'info', asked ? asked.question : answer, { kind: 'chat' })
				return answer
			} finally {
				unsubscribe()
			}
		} catch (error) {
			if (state.aborted) return ''
			failure = classifyFailure(error)
			console.error('[agent] turn failed:', error)
			ping('error', failure.body, failure.route)
			return ''
		} finally {
			// Setup failed before it could change history, so keep the last transcript.
			const entries = built ? await readHistory(built) : history
			publishHistory(entries)
			if (running === state) running = null
			status = { state: 'idle' }
			emit({
				type: 'status',
				status,
				...(failure ? { error: { message: failure.body, route: failure.route } } : {})
			})
		}
	}

	// Keep the request while the runtime builds. Once built, abort the assistant too in case
	// the turn has moved past setup and reached the model.
	function abort(): boolean {
		if (!running) return false
		running.aborted = true
		if (!active) return true
		void active.built
			.then(({ assistant }) => assistant.abort())
			.catch((error) => console.error('[agent] abort failed:', error))
		return true
	}

	async function snapshot(): Promise<SessionSnapshot> {
		if (!running) history = await getBuilt().then(readHistory, () => history)
		historyLoaded = true
		return { history, status }
	}

	async function readHistory(built: Built): Promise<readonly SessionEntry[]> {
		try {
			return await built.assistant.history()
		} catch {
			return history
		}
	}

	async function publishItems(items: readonly SessionEntry[]): Promise<void> {
		if (items.length === 0) return
		history = [...history, ...items]
		emit({ type: 'items', items })
	}

	function publishHistory(next: readonly SessionEntry[]): void {
		if (sameEntries(history, next)) return
		const appended = next.slice(history.length)
		if (history.every((entry, index) => entry.id === next[index]?.id)) {
			history = next
			if (appended.length > 0) emit({ type: 'items', items: appended })
			return
		}
		history = next
		historyLoaded = true
		emit({ type: 'snapshot', snapshot: { history, status } })
	}

	// Stop the old turn before replacing its session. A turn admitted during the reset waits
	// at the run boundary, so it cannot write through the session swap.
	function newSession(): Promise<void> {
		if (resetting) return resetting
		const reset = Promise.resolve().then(async () => {
			const current = running
			if (current) {
				abort()
				await current.done
			}
			try {
				const built = await getBuilt()
				built.takePending()
				await built.assistant.newSession()
			} catch (error) {
				console.error('[agent] newSession failed:', error)
			}
			history = []
			historyLoaded = true
			emit({ type: 'snapshot', snapshot: { history, status } })
		})
		resetting = reset
		const clearReset = () => {
			if (resetting === reset) resetting = null
		}
		void reset.then(clearReset, clearReset)
		return reset
	}

	function applySkill(id: string): Promise<string> {
		const result = startTurn((assistant) => assistant.applySkill(id))
		return result.accepted ? result.done : Promise.resolve('')
	}

	// Only the main session rolls yesterday's daily notes into permanent memory.
	async function runMaintenance(): Promise<void> {
		if (target.kind !== 'main') return
		try {
			await consolidateMemory(volume, (await getBuilt()).text)
		} catch (error) {
			console.error('[agent] maintenance failed:', error)
		}
	}

	// App sessions return null because only main owns the daily maintenance alarm.
	async function nextMaintenanceAt(now: Date): Promise<number | null> {
		if (target.kind !== 'main') return null
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

function eventStatus(event: AgentEvent, current: SessionStatus): SessionStatus {
	if (event.type.startsWith('tool_execution_')) return { state: 'calling_tool', detail: event }
	if (event.type === 'message_update') {
		if (event.assistantMessageEvent.type === 'thinking_delta')
			return { state: 'thinking', detail: event }
		if (event.assistantMessageEvent.type === 'text_delta')
			return { state: 'responding', detail: event }
	}
	if (event.type === 'message_start' && event.message.role === 'assistant')
		return { state: 'thinking', detail: event }
	return {
		state: current.state === 'idle' ? 'thinking' : current.state,
		detail: event
	}
}

function sameEntries(left: readonly SessionEntry[], right: readonly SessionEntry[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry.id === right[index]?.id)
}

// Classify a failed turn into a user-facing message + a fix-it route. pi-ai surfaces provider
// failures as plain `Error` messages (not typed codes), so we match on the text: an
// expired/unauthorised token → reconnect in Settings → Accounts; a spent platform quota → the
// account pane; a blown context window → back to chat; a network failure → retry from chat.
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
	if (/quota[_ ]?exceeded|usage limit/i.test(raw)) {
		return {
			body: 'Your Kodama AI limit reached. Wait for it to reset or upgrade your plan.',
			route: { kind: 'settings', pane: 'accounts' }
		}
	}
	if (/context[_ ]?(length|window)|token limit|maximum context|too many tokens/i.test(raw)) {
		return {
			body: 'The model hit its token limit. Start a new chat or shorten your request.',
			route: { kind: 'chat' }
		}
	}
	if (/\b429\b|rate limit/i.test(raw)) {
		return {
			body: 'The AI provider is busy. Try again shortly.',
			route: { kind: 'chat' }
		}
	}
	if (/fetch failed|failed to fetch|econnrefused|network error|\boffline\b/i.test(raw)) {
		return {
			body: 'Kodama AI is offline. Check your connection and try again.',
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
