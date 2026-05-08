import { describe, expect, test } from 'bun:test'
import { Type } from 'typebox'
import { define as defineApp } from './app.js'
import { mockCapabilities } from './capabilities/core.js'
import { email } from './capabilities/email/index.js'
import { engine, type Snapshot } from './engine.js'
import { Runner } from './runner.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

function loadingApp() {
	const initialContext: { reason: string; items: string[] | null; error: string | null } = {
		reason: 'morning',
		items: null,
		error: null
	}

	return defineApp({
		name: 'loading-test',
		description: 'invoke test app',
		engine: engine()
			.withTasks(({ task }) => ({
				loadBriefing: task<{ reason: string }, { items: string[] }>(async ({ input }) => {
					return { items: [`for-${input.reason}`] }
				})
			}))
			.build({
				initial: 'loading' as 'idle' | 'loading' | 'briefing' | 'failed',
				context: initialContext,
				states: {
					idle: {
						on: {
							load: {
								schema: Type.Object({ reason: Type.String() }),
								target: 'loading',
								actions: ({ context, action }) => ({
									...context,
									reason: (action.payload as { reason: string }).reason
								})
							}
						}
					},
					loading: {
						invoke: {
							src: 'loadBriefing',
							input: ({ context }) => ({ reason: context.reason }),
							onDone: ({ output }) => ({ type: 'load_briefing', payload: output }),
							onError: ({ error }) => ({ type: 'load_failed', payload: { message: error.message } })
						},
						on: {
							load_briefing: {
								schema: Type.Object({ items: Type.Array(Type.String()) }),
								actor: 'system',
								target: 'briefing',
								actions: ({ context, action }) => ({
									...context,
									items: (action.payload as { items: string[] }).items
								})
							},
							load_failed: {
								schema: Type.Object({ message: Type.String() }),
								actor: 'system',
								target: 'failed',
								actions: ({ context, action }) => ({
									...context,
									error: (action.payload as { message: string }).message
								})
							},
							cancel: {
								schema: Type.Object({}),
								target: 'idle'
							}
						}
					},
					briefing: {
						on: {
							reload: {
								schema: Type.Object({}),
								target: 'loading'
							}
						}
					},
					failed: {}
				}
			})
	})
}

describe('Runner invoke lifecycle', () => {
	test('runs invoke on initial state entry and dispatches onDone as system', async () => {
		const runner = new Runner({ app: loadingApp() })
		await runner.start()
		// Let the task microtask + result dispatch settle.
		await flush()
		await flush()
		const snap = runner.snapshot
		expect(snap.state).toBe('briefing')
		expect((snap.context as { items: string[] | null }).items).toEqual(['for-morning'])
	})

	test('exits invoking state before task settles → result is ignored', async () => {
		const app = defineApp({
			name: 'stale',
			description: '',
			engine: engine()
				.withTasks(({ task }) => ({
					slow: task<void, string>(
						async ({ signal }) =>
							new Promise<string>((resolve, reject) => {
								const t = setTimeout(() => resolve('late'), 50)
								signal.addEventListener('abort', () => {
									clearTimeout(t)
									reject(new Error('aborted'))
								})
							})
					)
				}))
				.build({
					initial: 'loading' as 'loading' | 'idle' | 'done',
					context: {},
					states: {
						loading: {
							invoke: {
								src: 'slow',
								onDone: ({ output }) => ({ type: 'finish', payload: { v: output } })
							},
							on: {
								cancel: { schema: Type.Object({}), target: 'idle' },
								finish: {
									schema: Type.Object({ v: Type.String() }),
									actor: 'system',
									target: 'done'
								}
							}
						},
						idle: {},
						done: {}
					}
				})
		})
		const runner = new Runner({ app })
		await runner.start()
		const r = await runner.dispatch({ type: 'cancel', payload: {} }, { id: 'user' })
		expect(r.ok).toBe(true)
		// Wait beyond the slow task's timer.
		await new Promise((res) => setTimeout(res, 80))
		expect(runner.snapshot.state).toBe('idle')
	})

	test('task failure dispatches onError as system', async () => {
		const app = defineApp({
			name: 'fail',
			description: '',
			engine: engine()
				.withTasks(({ task }) => ({
					boom: task<void, never>(async () => {
						throw new Error('nope')
					})
				}))
				.build({
					initial: 'loading' as 'loading' | 'failed',
					context: { msg: '' },
					states: {
						loading: {
							invoke: {
								src: 'boom',
								onError: ({ error }) => ({ type: 'failed', payload: { msg: error.message } })
							},
							on: {
								failed: {
									schema: Type.Object({ msg: Type.String() }),
									actor: 'system',
									target: 'failed',
									actions: ({ action }) => ({
										msg: (action.payload as { msg: string }).msg
									})
								}
							}
						},
						failed: {}
					}
				})
		})
		const runner = new Runner({ app })
		await runner.start()
		await flush()
		await flush()
		expect(runner.snapshot.state).toBe('failed')
		expect((runner.snapshot.context as { msg: string }).msg).toBe('nope')
	})

	test('apps without tasks keep behaving exactly like pure dispatch', async () => {
		const app = defineApp({
			name: 'plain',
			description: '',
			engine: engine().build({
				initial: 'a' as 'a' | 'b',
				context: { n: 0 },
				states: {
					a: {
						on: {
							next: {
								schema: Type.Object({}),
								target: 'b',
								actions: ({ context }) => ({ n: context.n + 1 })
							}
						}
					},
					b: {}
				}
			})
		})
		const runner = new Runner({ app })
		await runner.start()
		const r = await runner.dispatch({ type: 'next', payload: {} }, { id: 'u' })
		expect(r.ok).toBe(true)
		expect(runner.snapshot.state).toBe('b')
		expect((runner.snapshot.context as { n: number }).n).toBe(1)
	})

	test('same-state transition does not restart invoke unless reenter:true', async () => {
		let starts = 0
		const app = defineApp({
			name: 'reenter',
			description: '',
			engine: engine()
				.withTasks(({ task }) => ({
					counter: task<void, number>(async () => {
						starts++
						await new Promise((r) => setTimeout(r, 100))
						return starts
					})
				}))
				.build({
					initial: 'loading' as 'loading',
					context: {},
					states: {
						loading: {
							invoke: { src: 'counter' },
							on: {
								ping: { schema: Type.Object({}) }
							}
						}
					}
				})
		})
		const runner = new Runner({ app })
		await runner.start()
		await flush()
		expect(starts).toBe(1)
		await runner.dispatch({ type: 'ping', payload: {} }, { id: 'u' })
		await flush()
		expect(starts).toBe(1)
		runner.stop()
	})

	test('reenter:true restarts invoke on same-state transition', async () => {
		let starts = 0
		const app = defineApp({
			name: 'reenter',
			description: '',
			engine: engine()
				.withTasks(({ task }) => ({
					counter: task<void, number>(async ({ signal }) => {
						starts++
						return new Promise<number>((resolve, reject) => {
							const t = setTimeout(() => resolve(starts), 100)
							signal.addEventListener('abort', () => {
								clearTimeout(t)
								reject(new Error('aborted'))
							})
						})
					})
				}))
				.build({
					initial: 'loading' as 'loading',
					context: {},
					states: {
						loading: {
							invoke: { src: 'counter', reenter: true },
							on: {
								ping: { schema: Type.Object({}) }
							}
						}
					}
				})
		})
		const runner = new Runner({ app })
		await runner.start()
		await flush()
		expect(starts).toBe(1)
		await runner.dispatch({ type: 'ping', payload: {} }, { id: 'u' })
		await flush()
		expect(starts).toBe(2)
		runner.stop()
	})

	test('multiple concurrent invokes per state run independently', async () => {
		const seen: string[] = []
		const app = defineApp({
			name: 'multi',
			description: '',
			engine: engine()
				.withTasks(({ task }) => ({
					a: task<void, string>(async () => 'A'),
					b: task<void, string>(async () => 'B')
				}))
				.build({
					initial: 'loading' as 'loading',
					context: {},
					states: {
						loading: {
							invoke: [
								{ src: 'a', onDone: ({ output }) => ({ type: 'noteA', payload: { v: output } }) },
								{ src: 'b', onDone: ({ output }) => ({ type: 'noteB', payload: { v: output } }) }
							],
							on: {
								noteA: {
									schema: Type.Object({ v: Type.String() }),
									actor: 'system',
									actions: ({ action }) => {
										seen.push(`A:${(action.payload as { v: string }).v}`)
										return {}
									}
								},
								noteB: {
									schema: Type.Object({ v: Type.String() }),
									actor: 'system',
									actions: ({ action }) => {
										seen.push(`B:${(action.payload as { v: string }).v}`)
										return {}
									}
								}
							}
						}
					}
				})
		})
		const runner = new Runner({ app })
		await runner.start()
		await flush()
		await flush()
		await flush()
		expect(seen.sort()).toEqual(['A:A', 'B:B'])
	})

	test('runner restores snapshot from storage and starts invokes for current state', async () => {
		let saved: Snapshot | undefined = {
			state: 'briefing',
			context: { reason: 'morning', items: ['restored'], error: null }
		}
		const storage = {
			async load() {
				return saved
			},
			async save(s: Snapshot) {
				saved = s
			}
		}
		const runner = new Runner({ app: loadingApp(), storage })
		await runner.start()
		expect(runner.snapshot.state).toBe('briefing')
		expect((runner.snapshot.context as { items: string[] }).items).toEqual(['restored'])
	})

	test('reset re-enters initial state and restarts invokes', async () => {
		const runner = new Runner({ app: loadingApp() })
		await runner.start()
		await flush()
		await flush()
		expect(runner.snapshot.state).toBe('briefing')
		await runner.reset()
		await flush()
		await flush()
		expect(runner.snapshot.state).toBe('briefing')
	})

	test('tools(actor) excludes system-only actions when filtered by actor', () => {
		const runner = new Runner({ app: loadingApp() })
		const all = runner.tools().map((t) => t.name)
		expect(all).toContain('load_briefing')
		const userTools = runner.tools({ id: 'agent', kind: 'agent' }).map((t) => t.name)
		expect(userTools).not.toContain('load_briefing')
		expect(userTools).not.toContain('load_failed')
	})

	test('onDone return type is inferred from the engine action union', async () => {
		const app = defineApp({
			name: 'typed',
			description: '',
			engine: engine()
				.withTasks(({ task }) => ({
					load: task<void, { items: number[] }>(async () => ({ items: [1, 2] }))
				}))
				.build({
					initial: 'a' as 'a' | 'b',
					context: { items: [] as number[] },
					states: {
						a: {
							on: {
								gotItems: {
									schema: Type.Object({ items: Type.Array(Type.Number()) }),
									actor: 'system',
									target: 'b',
									actions: ({ action }) => ({
										items: (action.payload as { items: number[] }).items
									})
								}
							},
							invoke: {
								src: 'load',
								// onDone's return is constrained to ActionFromStates<States>:
								// `type` must be 'gotItems' and `payload` must match its schema.
								onDone: ({ output }) => ({ type: 'gotItems' as const, payload: output })
							}
						},
						b: {}
					}
				})
		})
		const runner = new Runner({ app })
		await runner.start()
		await flush()
		await flush()
		expect(runner.snapshot.state).toBe('b')
		expect((runner.snapshot.context as { items: number[] }).items).toEqual([1, 2])
	})

	test('storage receives bare snapshot (no runtime metadata)', async () => {
		let last: Snapshot | undefined
		const storage = {
			async load() {
				return undefined
			},
			async save(s: Snapshot) {
				last = s
			}
		}
		const app = defineApp({
			name: 'persist',
			description: '',
			engine: engine().build({
				initial: 'a' as 'a' | 'b',
				context: { n: 0 },
				states: {
					a: {
						on: {
							next: {
								schema: Type.Object({}),
								target: 'b',
								actions: () => ({ n: 1 })
							}
						}
					},
					b: {}
				}
			})
		})
		const runner = new Runner({ app, storage })
		await runner.start()
		expect(last?.state).toBe('a')
		await runner.dispatch({ type: 'next', payload: {} }, { id: 'u' })
		expect(last?.state).toBe('b')
		expect(last).toEqual({ state: 'b', context: { n: 1 } })
	})

	test('typed ctx.capabilities reaches handler via fake bridge host()', async () => {
		const app = defineApp({
			name: 'caps',
			description: '',
			engine: engine()
				.withCapabilities([email({ scopes: ['read.unread'] })])
				.withTasks(({ task }) => ({
					loadInbox: task<void, { count: number }>(async ({ capabilities }) => {
						const list = await capabilities.email.listUnread({ limit: 5 })
						return { count: list.length }
					})
				}))
				.build({
					initial: 'loading' as 'loading' | 'done',
					context: { count: 0 },
					states: {
						loading: {
							invoke: {
								src: 'loadInbox',
								onDone: ({ output }) => ({ type: 'loaded', payload: output })
							},
							on: {
								loaded: {
									schema: Type.Object({ count: Type.Number() }),
									actor: 'system',
									target: 'done',
									actions: ({ action }) => ({
										count: (action.payload as { count: number }).count
									})
								}
							}
						},
						done: {}
					}
				})
		})
		const capabilities = mockCapabilities([email], {
			email: {
				listUnread: async () => [
					{ id: '1', from: 'a', subject: 's', receivedAt: 0, unread: true },
					{ id: '2', from: 'b', subject: 't', receivedAt: 0, unread: true }
				]
			}
		})
		const runner = new Runner({
			app,
			host: () => ({ capabilities })
		})
		await runner.start()
		await flush()
		await flush()
		expect(runner.snapshot.state).toBe('done')
		expect((runner.snapshot.context as { count: number }).count).toBe(2)
	})

	test('TaskError preserves capability/method when broker-style error is thrown', async () => {
		const app = defineApp({
			name: 'cap-err',
			description: '',
			engine: engine()
				.withTasks(({ task }) => ({
					boom: task<void, never>(async () => {
						throw {
							code: 'CAPABILITY_DENIED',
							message: 'no read.unread grant',
							capability: 'email',
							method: 'listUnread'
						}
					})
				}))
				.build({
					initial: 'loading' as 'loading' | 'failed',
					context: { cap: '', method: '', code: '' },
					states: {
						loading: {
							invoke: {
								src: 'boom',
								onError: ({ error }) => ({
									type: 'failed',
									payload: {
										cap: error.capability ?? '',
										method: error.method ?? '',
										code: error.code
									}
								})
							},
							on: {
								failed: {
									schema: Type.Object({
										cap: Type.String(),
										method: Type.String(),
										code: Type.String()
									}),
									actor: 'system',
									target: 'failed',
									actions: ({ action }) =>
										action.payload as { cap: string; method: string; code: string }
								}
							}
						},
						failed: {}
					}
				})
		})
		const runner = new Runner({ app })
		await runner.start()
		await flush()
		await flush()
		expect(runner.snapshot.state).toBe('failed')
		expect(runner.snapshot.context).toEqual({
			cap: 'email',
			method: 'listUnread',
			code: 'CAPABILITY_DENIED'
		})
	})

	test('host() factory receives TaskMeta for each invoke', async () => {
		const seen: { taskId: string; state: string; runIdLen: number }[] = []
		const app = defineApp({
			name: 'meta',
			description: '',
			engine: engine()
				.withTasks(({ task }) => ({
					ping: task<void, string>(async () => 'ok')
				}))
				.build({
					initial: 'loading' as 'loading' | 'done',
					context: {},
					states: {
						loading: {
							invoke: {
								src: 'ping',
								onDone: () => ({ type: 'finish', payload: {} })
							},
							on: {
								finish: { schema: Type.Object({}), actor: 'system', target: 'done' }
							}
						},
						done: {}
					}
				})
		})
		const runner = new Runner({
			app,
			host: (meta) => {
				seen.push({ taskId: meta.taskId, state: meta.state, runIdLen: meta.runId.length })
				return {}
			}
		})
		await runner.start()
		await flush()
		await flush()
		expect(seen.length).toBe(1)
		expect(seen[0]?.taskId).toBe('ping')
		expect(seen[0]?.state).toBe('loading')
		expect(seen[0]?.runIdLen).toBeGreaterThan(0)
	})

	test('mockCapabilities throws on un-stubbed methods', () => {
		const fakes = mockCapabilities([email], {})
		expect(() => (fakes.email.listUnread as () => unknown)()).toThrow(
			/email\.listUnread\(\) is not stubbed/
		)
	})
})
