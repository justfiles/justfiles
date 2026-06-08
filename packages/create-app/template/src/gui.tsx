import type { GUIProps } from '@justfiles/app/react'
import type { app } from './app'

export default function Example({ state, actions }: GUIProps<typeof app>) {
	return (
		<button type="button" onClick={() => void actions.increment({ amount: 1 })}>
			count: {state.count}
		</button>
	)
}
