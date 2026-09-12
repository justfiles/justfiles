import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { expect, test, vi } from 'vitest'
import { appBundleFromMemory } from '../../app.ts'
import { kernel } from '../../kernel.ts'
import { app } from '../../test-bundle/ai-run-agent.ts'
import { capabilityRegistry } from '../index.ts'
import { volumeCapability } from '../volume/host.ts'
import { devAiForApp, type GenerateText } from './dev.ts'

const tool = (capability: string, method?: string, ...args: unknown[]) => ({
	type: 'tool_call',
	name: 'capability',
	arguments: { capability, method, args }
})

async function setup() {
	const contexts: unknown[] = []
	const generate: GenerateText = Object.assign(async () => 'text unchanged', {
		agent: async ({ prompt }) => {
			const context = JSON.parse(prompt)
			contexts.push(context)
			const last = context.messages.at(-1)
			if (context.tools[0]?.name === 'lookupFixture')
				return JSON.stringify(
					last.role === 'toolResult'
						? { type: 'final', text: last.content[0].text }
						: { type: 'tool_call', name: 'lookupFixture', arguments: {} }
				)
			const steps = JSON.parse(
				typeof context.messages[0].content === 'string'
					? context.messages[0].content
					: context.messages[0].content[0].text
			)
			const results = context.messages.filter(({ role }) => role === 'toolResult')
			return JSON.stringify(
				steps[results.length] ?? { type: 'final', text: JSON.stringify(results) }
			)
		}
	})
	const { capability } = await devAiForApp('one', app.capabilities, generate)
	const fs = volume(memStore())
	for (const path of ['/examples', '/different']) {
		await fs.mkdir(path)
		await fs.writeFile(`${path}/source`, new TextEncoder().encode(path))
	}
	const files = volumeCapability(fs)
	const fileCalls = vi.fn(files.invoke)
	const inbox = vi.fn(async () => [{ subject: 'hello' }])
	const k = kernel({
		fs,
		clock: {},
		capabilities: capabilityRegistry({
			ai: capability!,
			volume: { ...files, invoke: fileCalls },
			email: { invoke: inbox, subscribe: vi.fn() }
		}),
		sandbox: async ({ appId }) => ({
			run: (action, ctx) => app.dispatch(action, ctx),
			initialState: async () => app.initialState,
			actions: async () => app.actions,
			capabilities: async () =>
				appId === 'one'
					? app.capabilities
					: {
							model: app.capabilities.model,
							files: app.capabilities.files,
							examples: { id: 'volume', scopes: ['/different'] }
						},
			runProcedure: (name, input, handle) => app.runProcedure(name, input, handle)
		})
	})
	for (const id of ['one', 'two'])
		await k.install(appBundleFromMemory({ id, name: id, app: '// test sandbox' }))
	return {
		k,
		fs,
		inbox,
		fileCalls,
		contexts,
		close: async () => {
			await capability!.dispose()
			k.dispose()
		}
	}
}

test.each([
	'work',
	'command'
])('text provider preserves inherited identity and grants through %s dispatch', async (type) => {
	const host = await setup()
	try {
		const steps = [
			tool('examples', 'readFile', '/source'),
			tool('files'),
			tool('files', 'writeFile', '/outside-candidate/note', { $bytes: 'saved 🦊' }),
			tool('inbox', 'listUnread', { limit: 1 }),
			tool('volume', 'writeFile', '/escape', { $bytes: 'denied' })
		]
		await host.k.dispatch('one', {
			type,
			actor: 'agent',
			params: { requestId: 'one', prompt: JSON.stringify(steps) }
		})
		expect(
			new TextDecoder().decode(await host.fs.readFile('/data/one/outside-candidate/note'))
		).toBe('saved 🦊')
		expect(await host.fs.exists('/escape')).toBe(false)
		expect(host.fileCalls).toHaveBeenCalledTimes(2)
		expect(host.fileCalls).toHaveBeenCalledWith(
			expect.objectContaining({ appId: 'one', scopes: ['/examples'], method: 'readFile' })
		)
		expect(host.inbox).toHaveBeenCalledWith(
			expect.objectContaining({ appId: 'one', scopes: ['read'], method: 'listUnread' })
		)
		expect(JSON.stringify(host.contexts)).toContain('undeclared capability: volume')
		expect(JSON.stringify(host.contexts)).toContain('writeFile(')
		const second = await host.k.dispatch('two', {
			type: 'work',
			params: {
				requestId: 'two',
				prompt: JSON.stringify([
					tool('examples', 'readFile', '/source'),
					tool('inbox', 'listUnread', {})
				])
			}
		})
		expect(second.text).toContain('/different')
		expect(second.text).toContain('undeclared capability: inbox')
		expect(host.inbox).toHaveBeenCalledTimes(1)
		expect(host.fileCalls).toHaveBeenCalledWith(
			expect.objectContaining({ appId: 'two', scopes: ['/different'] })
		)
	} finally {
		await host.close()
	}
})
