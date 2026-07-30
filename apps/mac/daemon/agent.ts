import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	type AgentSession,
	createAgentSession,
	type SessionEntry,
	type SessionEvent
} from '@justfiles/agent'
import { type AppControllerPorts, createAppController } from '@justfiles/app'
import { resolveAgentBackend } from './chatgpt'
import { buildCommands, type CommandMeta, type CommandResult, SYSTEM_COMMANDS } from './commands'
import { getVolume } from './fs'
import { getKernel } from './kernel'
import { accountsSecretCodec } from './keychain'
import { notificationChannel } from './notify'
import type { AgentEvent } from './protocol'
import { DOCS_DIR } from './resources'

// The turn runner, tool wiring, backend rebuild-on-rotate, error classification, and
// notification pings all live in `createAgentSession` now; re-export its classifier so the
// daemon's chat/banner still key off the same fix-it routes.
export { classifyFailure } from '@justfiles/agent'

// Opening/closing a window is native-touching: from the daemon we `open` the
// materialised bundle and `pkill` its booter. The agent drives apps through the
// SAME kernel the windows subscribe to (createAppController lives in @justfiles/app),
// so an open window updates live the moment the agent runs an action.

// The materialised bundle (in ~/Applications/Kodama Apps, projected by the daemon)
// and a `pkill -f` pattern matching its running booter (argv[0] is the bundle's
// executable path) — used to `open`/quit real windows. The filesystem-safe name
// mirrors the daemon's exec() in materialize.ts.
const execName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '') || 'App'
const bundlePath = (name: string): string =>
	join(homedir(), 'Applications', 'Kodama Apps', `${execName(name)}.app`)
const bundleProcessPattern = (name: string): string =>
	`${execName(name)}.app/Contents/MacOS/${execName(name)}`

// `Bun.spawn` with array args runs the binary directly (no shell ⟹ no injection),
// the Bun-native stand-in for node:child_process. Fire-and-forget: we don't await
// `.exited`, and `stdio: ignore` keeps `pkill`'s "no match" (exit 1) and `open`'s
// output from touching the daemon's streams.
const nativeWindows: AppControllerPorts['windows'] = {
	open: (_id, name) =>
		void Bun.spawn(['open', bundlePath(name)], { stdout: 'ignore', stderr: 'ignore' }),
	close: (_id, name) =>
		void Bun.spawn(['pkill', '-f', bundleProcessPattern(name)], {
			stdout: 'ignore',
			stderr: 'ignore'
		})
}

// ── The shared agent session ──────────────────────────────────────────────
//
// The daemon runs ONE agent session (built lazily, memoised): every chat subscribes to its
// transcript and the `/system` command handler drives the same session, so a `/skill` turn
// shows up live in an open chat. The turn runner, tool wiring, backend rebuild-on-rotate,
// error classification, and notification pings all live in `createAgentSession`
// (@justfiles/agent) — the daemon supplies only its ports (a Volume, the ChatGPT-resolved
// backend, the native AppController, the notify channel, a docs reader) and maps its own
// slash commands onto the session's semantic methods (`newSession` / `applySkill`).
let sessionPromise: Promise<AgentSession> | null = null

function getSession(): Promise<AgentSession> {
	if (!sessionPromise) sessionPromise = buildSession()
	return sessionPromise
}

async function buildSession(): Promise<AgentSession> {
	const fs = await getVolume()
	const session = createAgentSession({
		volume: fs,
		// Re-resolve every turn so a model switch / reconnect / OAuth refresh takes effect on
		// the next prompt without restarting the daemon (resolveAgentBackend rotates near-expiry
		// tokens; the session keys its build on model + revision and rebuilds losslessly).
		backend: async () => {
			const llm = await resolveAgentBackend(fs, { secretCodec: accountsSecretCodec })
			if (!llm) throw new Error('failed to get llm config')
			return llm
		},
		// The agent drives apps through the SAME kernel the windows subscribe to, so
		// `app launch`/`app run` update live windows the moment they run.
		apps: createAppController(await getKernel(), { windows: nativeWindows }),
		notify: notificationChannel,
		title: 'Kodama',
		// The `read_doc` tool + docs system-prompt block: repo-root docs/*.md, resolved via
		// DOCS_DIR; Bun reads the file at tool-call time.
		readDoc: (id) => Bun.file(join(DOCS_DIR, `${id}.md`)).text()
	})
	// Fan the session's events out to every connected chat via the sink main.ts wired (the
	// `agent` pub/sub topic). `transcript` becomes the daemon's `history` frame.
	session.subscribe((event) => broadcast(toAgentEvent(event)))
	return session
}

// The session's broad event union → the daemon's `/agent` wire (protocol.ts). An error's
// fix-it `route` is consumed by the session's own notification ping, so the wire drops it.
function toAgentEvent(event: SessionEvent): AgentEvent {
	switch (event.type) {
		case 'transcript':
			return { type: 'history', entries: event.entries }
		case 'busy':
			return { type: 'busy', value: event.value }
		case 'error':
			return { type: 'error', message: event.message }
	}
}

// The daemon injects a sink that publishes `/agent` events to every connected chat (main.ts
// wires it to the `agent` pub/sub topic). The no-op default keeps the session usable before
// the server binds it.
let broadcast: (event: AgentEvent) => void = () => {}
export function setAgentBroadcast(sink: (event: AgentEvent) => void): void {
	broadcast = sink
}

// The current transcript, for the snapshot a chat gets on connect. Empty when the session
// can't build (no backend), so the chat shows an empty transcript rather than erroring.
export async function agentHistory(): Promise<readonly SessionEntry[]> {
	return (await getSession()).history()
}

// A chat message from the user. Fire-and-observe: the turn runs and its result reaches the
// chat through the broadcast, so callers don't await it.
export function promptAgent(message: string): void {
	void getSession()
		.then((session) => session.prompt(message))
		.catch((err) => console.error('[agent] prompt failed:', err))
}

// Cancel the in-flight turn, leaving the session intact so later prompts still work. Guards
// on the memoised session so a cold daemon never builds an agent just to cancel nothing.
export function abortAgent(): void {
	if (!sessionPromise) return
	void sessionPromise
		.then((session) => session.abort())
		.catch((err) => console.error('[agent] abort failed:', err))
}

// Dispatch a slash command by name. Commands are a DAEMON concept (see commands.ts) — the
// session only ever gets skill/session primitives (`applySkill` / `newSession`), never a
// command. The result tells the launcher what to show; a skill's turn is recorded by the
// session as normal conversation, surfacing live via the broadcast.
export async function dispatchCommand(name: string): Promise<CommandResult> {
	if (name === 'debug') return { show: 'text', body: await debugReport() }
	try {
		const session = await getSession()
		if (name === 'new')
			await session.newSession() // re-emits an empty transcript → clears chats
		else void session.applySkill(name)
	} catch (err) {
		console.error(`[agent] /${name} failed:`, err)
		if (name === 'new') broadcast({ type: 'history', entries: [] })
	}
	return { show: 'chat' }
}

// A snapshot of what the agent runs with: session length + the resolved system prompt
// (persona + memory + docs). Logged to daemon.log and returned for the `/debug` text panel.
async function debugReport(): Promise<string> {
	try {
		const session = await getSession()
		const history = await session.history()
		const report = [
			'agent diagnostics',
			`session entries: ${history.length}`,
			'',
			'system prompt:',
			await session.systemPrompt()
		].join('\n')
		console.log(`[agent] /debug\n${report}`)
		return report
	} catch (err) {
		return `agent unavailable: ${err instanceof Error ? err.message : String(err)}`
	}
}

// The slash-command catalogue for the daemon's `/system` frame (the native launcher's
// `/` menu reads it): the daemon's built-ins plus one entry per Volume skill. The session's
// `listSkills` is LLM-free (reads the Volume, no backend), so the menu builds offline; a
// read failure still yields the built-ins.
export async function agentCommands(): Promise<CommandMeta[]> {
	try {
		return buildCommands(await (await getSession()).listSkills())
	} catch (err) {
		console.error('[agent] commands catalogue failed:', err)
		return [...SYSTEM_COMMANDS]
	}
}
