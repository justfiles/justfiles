// Constructs a fresh `Host` per app mount and bundles the host-side controls
// (tool invocation, current describe callback, disposal) needed by the agent
// runtime. Per-mount state — describe callback, registered tools — lives on
// this instance so it cannot leak across slot swaps.

import {
	type Agent,
	APP_CONTRACT_VERSION,
	type Capabilities,
	type Host,
	NotFoundError,
	type Volume
} from './contract.js'
import {
	createToolRegistry,
	type RegisteredTool,
	type ToolRegistryHandle
} from './tool-registry.js'

// Minimal storage backend the Host Factory needs to scope per-app I/O.
// Matches the subset of `@justfiles/fs.Volume` we use; defined structurally
// so the contract package stays dependency-free.
export interface VolumeBackend {
	readFile(path: string): Promise<Uint8Array>
	writeFile(path: string, data: Uint8Array): Promise<void>
	mkdir(path: string, opts: { recursive: boolean }): Promise<void>
}

// App-sourced prompt → visible assistant turn text. The host wires this to
// the agent runtime; the contract is "run the prompt as if the app sent it
// and resolve with the assistant's visible reply".
export type SendAgentPrompt = (text: string) => Promise<string>

export interface CreateHostOptions {
	appId: string
	volume: VolumeBackend
	capabilities: Capabilities
	/** Optional — apps that don't use the agent omit it. When absent,
	 *  `host.agent.send` throws. */
	sendAgentPrompt?: SendAgentPrompt
	onToolRegister?: (tool: RegisteredTool) => void
	onToolUnregister?: (name: string) => void
}

export interface HostInstance {
	readonly host: Host
	/** Host-side: invoke a registered tool by name; validates input. */
	invokeTool: ToolRegistryHandle['invoke']
	/** Host-side: snapshot of currently registered tools. */
	listTools: ToolRegistryHandle['list']
	/** Host-side: run the current describe callback, or return null. */
	describe(): Promise<string | null>
	/** Clean up per-mount state. Idempotent. */
	dispose(): void
}

export function createHost(opts: CreateHostOptions): HostInstance {
	const toolRegistry = createToolRegistry({
		onRegister: opts.onToolRegister,
		onUnregister: opts.onToolUnregister
	})

	let describeCallback: (() => string | Promise<string>) | null = null

	const agent: Agent = Object.freeze({
		async send(text: string): Promise<string> {
			if (typeof text !== 'string') throw new TypeError('text must be a string')
			const send = opts.sendAgentPrompt
			if (!send) throw new Error('agent is not available in this host')
			return await send(text)
		},
		describe(callback: () => string | Promise<string>) {
			if (typeof callback !== 'function') throw new TypeError('callback must be a function')
			describeCallback = callback
			return () => {
				if (describeCallback === callback) describeCallback = null
			}
		},
		tools: toolRegistry.registry
	})

	const host: Host = Object.freeze({
		version: APP_CONTRACT_VERSION,
		volume: createScopedVolume(opts.appId, opts.volume),
		capabilities: Object.freeze({ ...opts.capabilities }),
		agent
	})

	let disposed = false

	return {
		host,
		invokeTool: (name, input) => toolRegistry.invoke(name, input),
		listTools: () => toolRegistry.list(),
		async describe() {
			if (!describeCallback) return null
			return await describeCallback()
		},
		dispose() {
			if (disposed) return
			disposed = true
			describeCallback = null
			toolRegistry.dispose()
		}
	}
}

function createScopedVolume(appId: string, backend: VolumeBackend): Volume {
	const scope = `/apps/${appId}/private`

	const scopedPath = (raw: string): string => {
		if (typeof raw !== 'string' || raw.length === 0) {
			throw new Error('volume path must be a non-empty string')
		}
		const segments = raw.split('/').filter((s) => s !== '' && s !== '.')
		if (segments.length === 0) throw new Error('volume path must be a non-empty string')
		for (const s of segments) {
			if (s === '..' || s.includes('\0')) {
				throw new Error(`volume path is not allowed: ${raw}`)
			}
		}
		return `${scope}/${segments.join('/')}`
	}

	const readBytes = async (path: string): Promise<Uint8Array> => {
		try {
			return await backend.readFile(path)
		} catch (err) {
			if (isEnoent(err)) throw new NotFoundError(path)
			throw err
		}
	}

	const writeBytes = async (path: string, data: Uint8Array): Promise<void> => {
		const slash = path.lastIndexOf('/')
		if (slash > 0) await backend.mkdir(path.slice(0, slash), { recursive: true })
		await backend.writeFile(path, data)
	}

	return Object.freeze<Volume>({
		async readText(path) {
			return new TextDecoder().decode(await readBytes(scopedPath(path)))
		},
		async writeText(path, text) {
			await writeBytes(scopedPath(path), new TextEncoder().encode(text))
		},
		async readFile(path) {
			return await readBytes(scopedPath(path))
		},
		async writeFile(path, data) {
			await writeBytes(scopedPath(path), data)
		}
	})
}

const isEnoent = (err: unknown): boolean =>
	err instanceof Error && (err.message.startsWith('ENOENT') || err.name === 'NotFoundError')
