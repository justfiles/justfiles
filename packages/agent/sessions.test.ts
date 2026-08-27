import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model
} from '@earendil-works/pi-ai'
import type { AppController } from '@justfiles/app'
import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, test } from 'vitest'
import type { AgentBackend } from './llm.ts'
import type { AgentSessionOptions } from './session.ts'
import { createAgentSessions } from './sessions.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const NO_COMPACTION = { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }

test('builds the main session once on first use', () => {
	let builds = 0
	const sessions = createAgentSessions({
		volume: {} as AgentSessionOptions['volume'],
		get backend() {
			builds++
			return {} as AgentSessionOptions['backend']
		}
	})

	expect(builds).toBe(0)
	const main = sessions.main()
	expect(builds).toBe(1)
	expect(sessions.main()).toBe(main)
	expect(builds).toBe(1)
})

test('builds and memoizes one session per app', () => {
	let builds = 0
	const sessions = createAgentSessions({
		volume: {} as AgentSessionOptions['volume'],
		apps: controller(),
		get backend() {
			builds++
			return {} as AgentSessionOptions['backend']
		}
	})

	const dictionary = sessions.app('justfiles.dictionary')
	expect(sessions.app('justfiles.dictionary')).toBe(dictionary)
	expect(builds).toBe(1)
	expect(sessions.app('justfiles.files')).not.toBe(dictionary)
	expect(builds).toBe(2)
})

describe('app sessions', () => {
	test('share the backend and tools while keeping resumable transcripts apart', async () => {
		const vol = volume(memStore())
		const model = backend(['main reply', 'dictionary reply'])
		const options = {
			volume: vol,
			backend: model.value,
			apps: controller(),
			compaction: NO_COMPACTION
		}
		const sessions = createAgentSessions(options)

		await sessions.main().prompt('main question')
		await sessions.app('justfiles.dictionary').prompt('dictionary question')

		expect(model.calls).toHaveLength(2)
		expect(model.calls[1]?.systemPrompt).toContain('# attached app')
		expect(model.calls[1]?.systemPrompt).toContain('Dictionary (`justfiles.dictionary`)')
		expect(model.calls[1]?.systemPrompt).toContain('Current reducer state:\n{}')
		expect(model.calls[1]?.systemPrompt).toContain('app actions justfiles.dictionary')
		expect(model.calls[1]?.tools).toEqual(model.calls[0]?.tools)
		expect(model.calls[1]?.tools).toContain('bash')

		expect(await sessionFiles(vol, 'main')).toHaveLength(1)
		expect(await sessionFiles(vol, 'app.justfiles.dictionary')).toHaveLength(1)

		const fresh = createAgentSessions(options)
		expect(messages(await fresh.main().history())).toEqual(['main question', 'main reply'])
		expect(messages(await fresh.app('justfiles.dictionary').history())).toEqual([
			'dictionary question',
			'dictionary reply'
		])
	})

	test('resume old threads without retirement or maintenance', async () => {
		const vol = volume(memStore())
		await seedIdleSession(vol, 'main', 'old main question')
		await seedIdleSession(vol, 'app.justfiles.dictionary', 'old dictionary question')
		const model = backend([], 'a note from the retired main thread')
		const sessions = createAgentSessions({
			volume: vol,
			backend: model.value,
			apps: controller(),
			compaction: NO_COMPACTION
		})

		expect(await sessions.main().history()).toEqual([])
		expect(messages(await sessions.app('justfiles.dictionary').history())).toEqual([
			'old dictionary question'
		])
		expect(model.completions).toBe(1)

		const daily = `/system/memory/daily/${new Date().toISOString().slice(0, 10)}.md`
		expect(decoder.decode(await vol.readFile(daily))).toContain(
			'a note from the retired main thread'
		)

		const app = sessions.app('justfiles.dictionary')
		expect(await app.nextMaintenanceAt(new Date())).toBeNull()
		await app.runMaintenance()
		expect(model.completions).toBe(1)
	})

	test('refreshes attached app state before each turn', async () => {
		let state: unknown = { query: 'first' }
		const model = backend(['first reply', 'second reply'])
		const app = createAgentSessions({
			volume: volume(memStore()),
			backend: model.value,
			apps: controller(() => state),
			compaction: NO_COMPACTION
		}).app('justfiles.dictionary')

		await app.prompt('first question')
		state = { query: 'second' }
		await app.prompt('second question')

		expect(model.calls[0]?.systemPrompt).toContain('"query": "first"')
		expect(model.calls[1]?.systemPrompt).toContain('"query": "second"')
		expect(model.calls[1]?.systemPrompt).not.toContain('"query": "first"')
	})

	test('compact without writing app-thread notes to the daily journal', async () => {
		const vol = volume(memStore())
		const model = backend(['first reply', 'second reply'], 'compact summary', 5000)
		const sessions = createAgentSessions({
			volume: vol,
			backend: model.value,
			apps: controller(),
			compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 }
		})
		const app = sessions.app('justfiles.dictionary')

		await app.prompt('first question')
		await app.prompt('second question')

		const [file] = await sessionFiles(vol, 'app.justfiles.dictionary')
		const transcript = decoder.decode(
			await vol.readFile(`/system/agents/app.justfiles.dictionary/sessions/${file}`)
		)
		expect(transcript).toContain('"type":"compaction"')
		expect(model.completions).toBe(1)
		expect(await vol.exists('/system/memory/daily')).toBe(false)
	})
})

function backend(answers: string[], completion = '', tokens = 0) {
	const queue = [...answers]
	const calls: { systemPrompt?: string; tools: string[] }[] = []
	let completions = 0
	const streamFn: StreamFn = async (_model, context) => {
		calls.push({
			systemPrompt: context.systemPrompt,
			tools: context.tools?.map((tool) => tool.name).sort() ?? []
		})
		const stream = createAssistantMessageEventStream()
		const message = assistant(queue.shift() ?? '', queue.length === 0 ? tokens : 0)
		stream.push({ type: 'done', reason: 'stop', message })
		stream.end(message)
		return stream
	}
	const value = {
		model: { id: 'test', contextWindow: 1000 } as Model<Api>,
		streamFn,
		completeFn: async () => {
			completions++
			return assistant(completion)
		},
		revision: 'r1'
	} satisfies AgentBackend
	return {
		value,
		calls,
		get completions() {
			return completions
		}
	}
}

function assistant(text: string, tokens = 0): AssistantMessage {
	return {
		role: 'assistant',
		content: text ? [{ type: 'text', text }] : [],
		api: 'test',
		provider: 'test',
		model: 'test',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		},
		stopReason: 'stop',
		timestamp: Date.now()
	}
}

function controller(readState: () => unknown = () => ({})): AppController {
	const inspect = async (id: string) => ({
		id,
		name: id === 'justfiles.dictionary' ? 'Dictionary' : 'Files',
		description: '',
		state: readState(),
		actions: {}
	})
	return {
		list: async () => [],
		launch: inspect,
		close: async () => {},
		current: async () => undefined,
		inspect,
		state: async () => readState(),
		run: async () => undefined
	}
}

async function seedIdleSession(vol: Volume, agentId: string, content: string) {
	const dir = `/system/agents/${agentId}/sessions`
	await vol.mkdir(dir, { recursive: true })
	await vol.writeFile(
		`${dir}/2026-07-26T09-00-00Z-01d5e551.aaaa1111.jsonl`,
		encoder.encode(
			`${JSON.stringify({
				type: 'message',
				role: 'user',
				content,
				id: 'aaaa0001',
				parentId: null,
				ts: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
			})}\n`
		)
	)
}

async function sessionFiles(vol: Volume, agentId: string): Promise<string[]> {
	return (await vol.readdir(`/system/agents/${agentId}/sessions`))
		.map((entry) => entry.name)
		.filter((name) => name.endsWith('.jsonl'))
}

function messages(entries: readonly { type: string; content?: string }[]): string[] {
	return entries.flatMap((entry) =>
		entry.type === 'message' && entry.content ? [entry.content] : []
	)
}
