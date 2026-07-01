import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	type AppController,
	type Assistant,
	createAgent,
	createAppShellCommand,
	createAssistant,
	createFetchTool,
	createJustBashTool,
	text
} from '@justfiles/agent'
import type { Channel } from '@justfiles/app/capabilities/notify'
import type { Kernel } from '@justfiles/app/runtime'
import { RpcTarget } from 'capnweb'
import { resolveAgentBackend } from '../quayd/chatgpt'
import { getVolume } from './fs'
import { getKernel } from './kernel'
import { notificationChannel } from './notify'

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

class AgentImpl extends RpcTarget {
	// The agent is a trusted host service, so it pings the channel DIRECTLY with
	// `source: 'agent'` (sandboxed apps go through the capability). The native sink
	// suppresses the banner while the chat surface is in front, so it only surfaces
	// when you're away; one `threadId` coalesces re-posts into a single banner.
	constructor(
		private agent: Assistant,
		private channel: Channel
	) {
		super()
	}

	async prompt(message: string) {
		try {
			const answer = await this.agent.prompt(message)
			this.ping('info', answer)
			return answer
		} catch (err) {
			console.error('[agent] prompt failed:', err)
			this.ping('error', err instanceof Error ? err.message : String(err))
			throw err
		}
	}
	async history() {
		try {
			return await this.agent.history()
		} catch (err) {
			console.error('[agent] history failed:', err)
			throw err
		}
	}

	private ping(kind: 'info' | 'error', body: string): void {
		this.channel({
			id: crypto.randomUUID(),
			source: 'agent',
			kind,
			title: 'quay',
			body: summarize(body),
			threadId: 'agent',
			route: { kind: 'chat' }
		})
	}
}

// Trim an answer to a banner-sized one-liner: first line, capped, ellipsised.
function summarize(text: string): string {
	const line = text.trim().split('\n')[0] ?? ''
	return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

export async function agentRpcTarget() {
	const fs = await getVolume()
	const llm = await resolveAgentBackend(fs)
	if (!llm) throw new Error('failed to get llm config')

	const rt = await createAssistant({
		volume: fs,
		agent: createAgent(llm),
		text: text(llm),
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000
		}
	})

	// The agent drives apps through the SAME kernel the windows subscribe to, so
	// `app launch`/`app run` update live windows the moment they run.
	const controller = createAppController(await getKernel())
	const bash = createJustBashTool({
		volume: fs,
		commands: [createAppShellCommand(controller)]
	})

	rt.addTools([bash, createFetchTool()])

	return new AgentImpl(rt, notificationChannel)
}
