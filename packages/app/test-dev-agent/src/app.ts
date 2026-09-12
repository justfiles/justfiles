import { defineApp } from '@justfiles/app'
import { ai } from '@justfiles/app/capabilities/ai'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

export const app = defineApp({
	init: { ticks: 0 },
	capabilities: { model: ai({ scopes: ['agent'] }), files: volume({ scopes: ['app'] }) },
	update: (t) => ({ tick: t.on(v.object({}), (state) => ({ ticks: state.ticks + 1 })) }),
	procedures: (p) => ({
		work: p.procedure({
			schema: v.object({ requestId: v.string(), prompt: v.string() }),
			run: (input, app) => app.cap.model.runAgent(input)
		}),
		stop: p.procedure({
			schema: v.object({ requestId: v.string() }),
			run: (input, app) => app.cap.model.cancelAgent(input)
		}),
		read: p.procedure({
			schema: v.object({}),
			run: async (_, app) => new TextDecoder().decode(await app.cap.files.readFile('/research.md'))
		})
	})
})
