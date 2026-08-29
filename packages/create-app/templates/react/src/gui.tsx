import { defineReactGUI } from '@justfiles/app/react'
import type { CounterApp } from './app.ts'

export const gui = defineReactGUI<CounterApp>(({ state, client }) => (
	<button type="button" onClick={() => void client.increment({ amount: 1 })}>
		Count: {state?.count ?? 0}
	</button>
))
