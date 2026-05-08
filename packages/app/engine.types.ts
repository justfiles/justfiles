// Type-only assertions for the chained engine builder. This file is included
// in tsconfig so `tsc --noEmit` checks the `@ts-expect-error` markers below.
// Nothing here is exported or executed at runtime; it exists purely so the
// type system fails the build if the API drifts.

import { Type } from 'typebox'
import { calendar } from './capabilities/calendar/index.js'
import { email } from './capabilities/email/index.js'
import { engine } from './engine.js'
import { TaskErrorSchema } from './tasks.js'

// withCapabilities → withTasks → ctx.capabilities is typed.
const _typed = engine()
	.withCapabilities([email({ scopes: ['read.unread'] }), calendar({ scopes: ['read.today'] })])
	.withTasks(({ task }) => ({
		ok: task<void, number>(async ({ capabilities }) => {
			const list = await capabilities.email.listUnread({ limit: 1 })
			const events = await capabilities.calendar.listToday({ timezone: 'UTC' })
			return list.length + events.length
		})
	}))
	.build({
		initial: 'a' as 'a',
		context: {},
		states: { a: {} }
	})

// Undeclared capability id and unknown method are type errors.
const _strict = engine()
	.withCapabilities([email({ scopes: ['read.unread'] })])
	.withTasks(({ task }) => ({
		x: task<void, void>(async ({ capabilities }) => {
			// @ts-expect-error calendar is not declared
			capabilities.calendar
			// @ts-expect-error email.notAMethod does not exist on EmailCapability
			await capabilities.email.notAMethod()
		})
	}))
	.build({ initial: 'a' as 'a', context: {}, states: { a: {} } })

// Skipping withCapabilities → ctx.capabilities is empty.
const _empty = engine()
	.withTasks(({ task }) => ({
		x: task<void, void>(async ({ capabilities }) => {
			// @ts-expect-error no capability declared on this engine
			capabilities.email
		})
	}))
	.build({ initial: 'a' as 'a', context: {}, states: { a: {} } })

// TaskErrorSchema can be used as the schema for a system-actor transition.
const _errSchema = engine()
	.withTasks(({ task }) => ({
		boom: task<void, never>(async () => {
			throw new Error('x')
		})
	}))
	.build({
		initial: 'a' as 'a' | 'failed',
		context: {},
		states: {
			a: {
				invoke: {
					src: 'boom',
					onError: ({ error }) => ({ type: 'failed' as const, payload: error })
				},
				on: {
					failed: {
						schema: TaskErrorSchema,
						actor: 'system',
						target: 'failed'
					}
				}
			},
			failed: {}
		}
	})

// Order rigidity: withCapabilities is removed after withTasks.
const _afterTasks = engine().withTasks(() => ({}))
// @ts-expect-error withCapabilities removed after withTasks
_afterTasks.withCapabilities([email({ scopes: [] })])

// Apps without any tasks/caps work unchanged.
const _plain = engine().build({
	initial: 'a' as 'a',
	context: { n: 0 },
	states: {
		a: {
			on: {
				tick: {
					schema: Type.Object({}),
					actions: ({ context }) => ({ n: context.n + 1 })
				}
			}
		}
	}
})

// Reference everything so unused-locals doesn't fire.
export type _References = [
	typeof _typed,
	typeof _strict,
	typeof _empty,
	typeof _errSchema,
	typeof _afterTasks,
	typeof _plain
]
