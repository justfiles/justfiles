import * as v from 'valibot'
import { ai } from '../capabilities/ai/index.ts'
import { volume } from '../capabilities/volume/index.ts'
import { defineApp } from '../sdk.ts'

const request = v.object({
	requestId: v.string(),
	prompt: v.string(),
	workspace: v.optional(v.object({ capability: v.string(), path: v.string() }))
})
export const app = defineApp({
	init: { ticks: 0, result: '' },
	capabilities: { model: ai({ scopes: ['agent'] }), files: volume({ scopes: ['app'] }) },
	update: (t) => ({
		tick: t.on(v.object({}), (state) => ({ ...state, ticks: state.ticks + 1 })),
		command: t.on(request, (state, input) => [state, t.cmd('model', 'runAgent', input).to('done')]),
		done: t.fromResult('model', 'runAgent', (state, result) => ({
			...state,
			result: result.ok && 'text' in result.value ? result.value.text : 'stopped'
		}))
	}),
	procedures: (p) => ({
		work: p.procedure({ schema: request, run: (input, app) => app.cap.model.runAgent(input) }),
		stop: p.procedure({
			schema: v.object({ requestId: v.string() }),
			run: (input, app) => app.cap.model.cancelAgent(input)
		})
	})
})
