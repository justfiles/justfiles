import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	type AgentBackend,
	type AppController,
	type Assistant,
	createAgent,
	createAppShellCommand,
	createAskUserTool,
	createAssistant,
	createFetchTool,
	createJustBashTool,
	createSearchTool,
	listSkills,
	type SessionEntry,
	text
} from '@justfiles/agent'
import type { Kernel } from '@justfiles/app/runtime'
import type { Volume } from '@justfiles/fs'
import { resolveAgentBackend } from '../quayd/chatgpt'
import { buildCommands, type CommandMeta, type CommandResult, SYSTEM_COMMANDS } from './commands'
import { getVolume } from './fs'
import { getKernel } from './kernel'
import { notificationChannel } from './notify'
import type { AgentEvent } from './protocol'

// Opening/closing a window is native-touching: from the daemon we `open` the
// materialised bundle and `pkill` its booter. Injectable so tests drive the
// controller without touching LaunchServices.
export interface WindowOps {
	open(id: string, name: string): void
	close(name: string): void
}

// The agent↔kernel bridge: an AppController over the daemon's kernel whose
// launch/close drive REAL macOS bundles (`open` / `pkill` the materialised .app).
// The agent dispatches into the SAME kernel the windows subscribe to, so an open
// window updates live the moment the agent runs an action. `current` tracks the
// most-recently launched app — the daemon's best approximation of focus.
export function createAppController(
	kernel: Kernel,
	windows: WindowOps = nativeWindows
): AppController {
	let currentId: string | null = null

	const inspect = async (id: string) => {
		const installed = await kernel.app(id)
		return {
			id,
			name: installed.manifest.name,
			description: installed.manifest.description,
			state: await kernel.state(id),
			actions: await kernel.actions(id)
		}
	}

	return {
		list: async () =>
			(await kernel.list())
				.filter((app) => !app.id.startsWith('preview.'))
				.map((app) => ({ id: app.id, name: app.name, description: app.description })),
		launch: async (id) => {
			const app = await inspect(id)
			windows.open(id, app.name)
			currentId = id
			return app
		},
		close: async (id) => {
			const targetId = id ?? currentId
			if (!targetId) return
			windows.close((await kernel.app(targetId)).manifest.name)
			if (targetId === currentId) currentId = null
		},
		current: async () => (currentId ? inspect(currentId) : undefined),
		inspect,
		state: (id) => kernel.state(id),
		run: (id, action, params) =>
			kernel.dispatch(id, { type: action, params, actor: 'agent' } as never)
	}
}

// The materialised bundle (in ~/Applications/Quay Apps, projected by the daemon)
// and a `pkill -f` pattern matching its running booter (argv[0] is the bundle's
// executable path) — used to `open`/quit real windows. The filesystem-safe name
// mirrors the daemon's exec() in materialize.ts.
const execName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '') || 'App'
const bundlePath = (name: string): string =>
	join(homedir(), 'Applications', 'Quay Apps', `${execName(name)}.app`)
const bundleProcessPattern = (name: string): string =>
	`${execName(name)}.app/Contents/MacOS/${execName(name)}`

// `Bun.spawn` with array args runs the binary directly (no shell ⟹ no injection),
// the Bun-native stand-in for node:child_process. Fire-and-forget: we don't await
// `.exited`, and `stdio: ignore` keeps `pkill`'s "no match" (exit 1) and `open`'s
// output from touching the daemon's streams.
const nativeWindows: WindowOps = {
	open: (_id, name) =>
		void Bun.spawn(['open', bundlePath(name)], { stdout: 'ignore', stderr: 'ignore' }),
	close: (name) =>
		void Bun.spawn(['pkill', '-f', bundleProcessPattern(name)], {
			stdout: 'ignore',
			stderr: 'ignore'
		})
}

// A multiple-choice question the agent posed via `ask_user`, captured for the turn that's
// running so a turn can swap its banner ping to `question` once the runtime returns. The
// question itself lands in the session, so the transcript renders it without extra help.
interface PendingQuestion {
	question: string
	options: string[]
}

// The daemon runs ONE shared agent session (unlike a per-connection build): every chat
// subscribes to its transcript and the `/system` command handler drives the same session,
// so a `/skill` turn shows up live in an open chat. Built lazily and reset on failure so a
// sign-in after an offline start retries on the next use.
interface AgentSession {
	assistant: Assistant
	takePending: () => PendingQuestion | null
}

// Re-resolve the backend on every call and cache the built session keyed on `model +
// revision` (the token's opaque fingerprint, see AgentBackend). This makes a model switch,
// an account reconnect, or an OAuth token refresh (resolveAgentBackend rotates a near-expiry
// token) take effect on the next prompt without restarting the daemon — a built-once
// assistant seals the token in its streamFn closure and would 401 forever once it expires.
// Rebuilds are lossless: the conversation persists to the Volume session, which the fresh
// assistant reloads. The per-key promise dedupes concurrent builds; a build failure clears
// the cache so an offline start retries on the next use.
let active: { key: string; session: Promise<AgentSession> } | null = null
async function getAgent(): Promise<AgentSession> {
	const fs = await getVolume()
	const llm = await resolveAgentBackend(fs)
	if (!llm) throw new Error('failed to get llm config')
	const key = `${llm.model.id} ${llm.revision}`
	if (!active || active.key !== key) {
		const session = buildAgent(fs, llm).catch((err) => {
			if (active?.key === key) active = null
			throw err
		})
		active = { key, session }
	}
	return active.session
}

async function buildAgent(fs: Volume, llm: AgentBackend): Promise<AgentSession> {
	const assistant = await createAssistant({
		volume: fs,
		agent: createAgent(llm),
		text: text(llm),
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
	})

	// The agent drives apps through the SAME kernel the windows subscribe to, so
	// `app launch`/`app run` update live windows the moment they run.
	const controller = createAppController(await getKernel())
	const bash = createJustBashTool({ volume: fs, commands: [createAppShellCommand(controller)] })

	// `ask_user` records the question the agent poses; `takePending` reads-and-clears it so a
	// turn can ping a `question` banner instead of `info`.
	let pending: PendingQuestion | null = null
	const askUser = createAskUserTool((question, options) => {
		pending = { question, options }
	})
	const takePending = (): PendingQuestion | null => {
		const p = pending
		pending = null
		return p
	}

	assistant.addTools([bash, createFetchTool(), createSearchTool(), askUser])
	return { assistant, takePending }
}

// The daemon injects a sink that publishes `/agent` events to every connected chat (main.ts
// wires it to the `agent` pub/sub topic). Turns broadcast their transcript + busy/error
// through it, so the transcript is a live view of the session with no polling.
let broadcast: (event: AgentEvent) => void = () => {}
export function setAgentBroadcast(sink: (event: AgentEvent) => void): void {
	broadcast = sink
}

// Run one turn on the shared agent, publishing busy + the resulting transcript (or an
// error) to the chat subscribers and pinging the notification channel. `ask_user` ends a
// turn with a question that already lands in the session (the transcript renders it); we
// only swap the banner ping to `question`.
async function runTurn(run: (assistant: Assistant) => Promise<string>): Promise<void> {
	broadcast({ type: 'busy', value: true })
	try {
		const { assistant, takePending } = await getAgent()
		takePending() // drop any stale question before the turn
		const answer = await run(assistant)
		const asked = takePending()
		broadcast({ type: 'history', entries: [...(await assistant.history())] })
		ping(asked ? 'question' : 'info', asked ? asked.question : answer)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error('[agent] turn failed:', err)
		broadcast({ type: 'error', message })
		ping('error', message)
	} finally {
		broadcast({ type: 'busy', value: false })
	}
}

// The current transcript, for the snapshot a chat gets on connect. Empty when the agent
// can't build (no backend) so the chat shows an empty transcript rather than erroring.
export async function agentHistory(): Promise<readonly SessionEntry[]> {
	try {
		return await (await getAgent()).assistant.history()
	} catch {
		return []
	}
}

// A chat message from the user. Fire-and-observe: the turn runs and its result reaches the
// chat through the broadcast, so callers don't await it.
export function promptAgent(message: string): void {
	void runTurn((assistant) => assistant.prompt(message))
}

// Cancel the in-flight turn on the shared session, leaving the session intact so later
// prompts still work. Guards on the cached session so an abort never builds an agent just
// to cancel nothing; `abort()` on an idle assistant is a harmless no-op. Fire-and-forget,
// mirroring `promptAgent` — the aborted turn's outcome reaches the chat via the broadcast.
export function abortAgent(): void {
	if (!active) return
	void active.session
		.then(({ assistant }) => assistant.abort())
		.catch((err) => console.error('[agent] abort failed:', err))
}

// Dispatch a slash command by name. Commands are a DAEMON concept (see commands.ts) — the
// agent only ever gets skill/session primitives (`applySkill` / `newSession`), never a
// command. The result tells the launcher what to show; command output never touches the
// session, and a skill's turn is recorded by the agent as normal conversation.
export async function dispatchCommand(name: string): Promise<CommandResult> {
	if (name === 'new') {
		try {
			const { assistant, takePending } = await getAgent()
			takePending()
			await assistant.newSession()
		} catch (err) {
			console.error('[agent] /new failed:', err)
		}
		broadcast({ type: 'history', entries: [] })
		return { show: 'chat' }
	}
	if (name === 'debug') return { show: 'text', body: await debugReport() }
	// A skill: expand it into a turn on the shared agent. The transcript updates live via
	// the subscription, so reveal the chat now instead of awaiting the turn.
	void runTurn((assistant) => assistant.applySkill(name))
	return { show: 'chat' }
}

// A snapshot of what the agent runs with: session length + the resolved system prompt
// (persona + memory + docs). Logged to quayd.log and returned for the `/debug` text panel.
async function debugReport(): Promise<string> {
	try {
		const { assistant } = await getAgent()
		const history = await assistant.history()
		const report = [
			'agent diagnostics',
			`session entries: ${history.length}`,
			'',
			'system prompt:',
			assistant.systemPrompt()
		].join('\n')
		console.log(`[agent] /debug\n${report}`)
		return report
	} catch (err) {
		return `agent unavailable: ${err instanceof Error ? err.message : String(err)}`
	}
}

// Ping the notification channel as the trusted `agent` source (the native sink suppresses
// the banner while the chat is in front). One `threadId` coalesces re-posts.
function ping(kind: 'info' | 'error' | 'question', body: string): void {
	notificationChannel({
		id: crypto.randomUUID(),
		source: 'agent',
		kind,
		title: 'quay',
		body: summarize(body),
		threadId: 'agent',
		route: { kind: 'chat' }
	})
}

// Trim an answer to a banner-sized one-liner: first line, capped, ellipsised.
function summarize(value: string): string {
	const line = value.trim().split('\n')[0] ?? ''
	return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

// The slash-command catalogue for the daemon's `/system` frame (the native launcher's
// `/` menu reads it): the daemon's built-ins plus one entry per Volume skill. Sourced from
// the agent's LLM-free `listSkills`, so it needs no assistant/backend and works offline; a
// read failure still yields the built-ins.
export async function agentCommands(): Promise<CommandMeta[]> {
	try {
		return buildCommands(await listSkills(await getVolume()))
	} catch (err) {
		console.error('[agent] commands catalogue failed:', err)
		return [...SYSTEM_COMMANDS]
	}
}
