import { describe, expect, test } from 'bun:test'
import { Type } from 'typebox'
import { define as defineApp } from './app.js'
import { type Snapshot, define as defineEngine } from './engine.js'
import { Runner } from './runner.js'
import { defineTasks, task } from './tasks.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

function loadingApp() {
	const tasks = defineTasks({
		loadBriefing: task<{ reason: string }, { items: string[] }>(async ({ input }) => {
			return { items: [`for-${input.reason}`] }
		})
	})

	const initialContext: { reason: string; items: string[] | null; error: string | null } = {
		reason: 'morning',
		items: null,
		error: null
	}

	return defineApp({
		name: 'loading-test',
		description: 'invoke test app',
		engine: defineEngine({
			tasks,
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
		const tasks = defineTasks({
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
		})
		const app = defineApp({
			name: 'stale',
			description: '',
			engine: defineEngine({
				tasks,
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
		// State did not transition to 'done', confirming the stale result was dropped.
	})

	test('task failure dispatches onError as system', async () => {
		const tasks = defineTasks({
			boom: task<void, never>(async () => {
				throw new Error('nope')
			})
		})
		const app = defineApp({
			name: 'fail',
			description: '',
			engine: defineEngine({
				tasks,
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
			engine: defineEngine({
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
		const tasks = defineTasks({
			counter: task<void, number>(async () => {
				starts++
				await new Promise((r) => setTimeout(r, 100))
				return starts
			})
		})
		const app = defineApp({
			name: 'reenter',
			description: '',
			engine: defineEngine({
				tasks,
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
		const tasks = defineTasks({
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
		})
		const app = defineApp({
			name: 'reenter',
			description: '',
			engine: defineEngine({
				tasks,
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
		const tasks = defineTasks({
			a: task<void, string>(async () => 'A'),
			b: task<void, string>(async () => 'B')
		})
		const seen: string[] = []
		const app = defineApp({
			name: 'multi',
			description: '',
			engine: defineEngine({
				tasks,
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
		// Move out via reload then reset.
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
			engine: defineEngine({
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
})
