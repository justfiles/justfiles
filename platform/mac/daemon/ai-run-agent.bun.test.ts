import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model
} from '@earendil-works/pi-ai'
import type { AgentBackend } from '@justfiles/agent'
import { appBundleFromMemory } from '@justfiles/app'
import { createNativeStorage } from './fs.ts'
import { buildKernel, daemonAccounts } from './kernel.ts'
import { sandboxes } from './sandbox.ts'

function scripted(): AgentBackend {
	let turn = 0
	return {
		revision: 'scripted',
		model: { id: 'scripted' } as Model<Api>,
		completeFn: async () => {
			throw new Error('unused')
		},
		streamFn: () => {
			const content: AssistantMessage['content'] =
				turn++ === 0
					? [
							{
								type: 'toolCall',
								id: 'write',
								name: 'capability',
								arguments: {
									capability: 'files',
									method: 'writeFile',
									args: ['/report/report.md', { $bytes: 'report\n' }]
								}
							}
						]
					: [{ type: 'text', text: 'finished' }]
			const message: AssistantMessage = {
				role: 'assistant',
				content,
				stopReason: turn === 1 ? 'toolUse' : 'stop',
				api: 'scripted',
				provider: 'scripted',
				model: 'scripted',
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
				}
			}
			const stream = createAssistantMessageEventStream()
			stream.push({ type: 'done', reason: 'stop', message })
			stream.end(message)
			return stream
		}
	}
}

test('Mac procedures await agent output on native storage and can cancel backend setup', async () => {
	const support = await mkdtemp(join(tmpdir(), 'mac-agent-'))
	const storage = await createNativeStorage({ supportDir: support })
	const fs = storage.volume
	const started = Promise.withResolvers<void>()
	let pause = false
	const accounts = {
		...daemonAccounts(fs, { getToken: async () => null }),
		resolveBackend: async (signal?: AbortSignal) => {
			if (pause) {
				started.resolve()
				await new Promise((_, reject) =>
					signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
				)
			}
			return scripted()
		}
	}
	const k = await buildKernel(fs, accounts)
	const appId = 'test.mac-agent'
	sandboxes.retain(appId)
	try {
		const built = await Bun.build({
			entrypoints: [
				new URL('../../../packages/app/test-bundle/ai-run-agent.ts', import.meta.url).pathname
			],
			target: 'browser'
		})
		if (!built.success) throw new Error(built.logs.join('\n'))
		await k.install(
			appBundleFromMemory({ id: appId, name: 'Agent test', app: await built.outputs[0]!.text() })
		)
		const params = {
			requestId: 'one',
			prompt: 'write a report in /report'
		}
		expect(await k.dispatch(appId, { type: 'work', params })).toEqual({ text: 'finished' })
		expect(new TextDecoder().decode(await fs.readFile(`/data/${appId}/report/report.md`))).toBe(
			'report\n'
		)
		pause = true
		const pending = k.dispatch(appId, { type: 'work', params: { ...params, requestId: 'two' } })
		await started.promise
		expect(await k.dispatch(appId, { type: 'tick', params: {} })).toEqual({ ticks: 1, result: '' })
		expect(await k.dispatch(appId, { type: 'stop', params: { requestId: 'two' } })).toBe(true)
		expect(await pending).toEqual({ cancelled: true })
	} finally {
		k.dispose()
		sandboxes.release(appId)
		await storage.close()
		await rm(support, { recursive: true, force: true })
	}
}, 30_000)
