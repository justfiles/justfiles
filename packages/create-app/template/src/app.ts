import { defineApp, engine as engineBuilder } from '@justfiles/app'
import { Type } from 'typebox'

type Context = {
	count: number
}

const engine = engineBuilder().build({
	initial: 'ready',
	context: { count: 0 } satisfies Context,
	states: {
		ready: {
			on: {
				decrement: {
					description: 'Decrease the counter.',
					schema: Type.Object({}),
					actions: ({ context }) => ({ count: context.count - 1 })
				},
				increment: {
					description: 'Increase the counter.',
					schema: Type.Object({}),
					actions: ({ context }) => ({ count: context.count + 1 })
				}
			}
		}
	}
})

export default defineApp({
	name: 'Counter',
	description: 'A minimal counter app.',
	engine,
	agent: {
		briefing: 'This app increments and decrements a counter.'
	}
})
