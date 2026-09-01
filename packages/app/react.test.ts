import type { ReactElement } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { App } from './app.ts'
import { defineReactGUI, type GUIProps } from './react.ts'
import type { Transport } from './sdk.ts'

const reactRoot = vi.hoisted(() => ({
	create: vi.fn(),
	render: vi.fn(),
	unmount: vi.fn()
}))

vi.mock('react-dom/client', () => ({ createRoot: reactRoot.create }))

type CounterApp = App<{ count: number }>

beforeEach(() => {
	vi.clearAllMocks()
	reactRoot.create.mockReturnValue({ render: reactRoot.render, unmount: reactRoot.unmount })
})

test('defineReactGUI owns the root and renders state through component props', async () => {
	let push!: (state: unknown) => void
	const unsubscribe = vi.fn()
	const transport: Transport = {
		invoke: async () => undefined,
		subscribe(onState) {
			push = onState
			return unsubscribe
		}
	}
	const Component = (_props: GUIProps<CounterApp>) => null
	const element = {} as HTMLElement
	const initial = { count: 1 }
	const mounted = defineReactGUI<CounterApp>(Component).mount(element, initial, {
		transport,
		dialog: { request: async () => undefined }
	})

	expect(reactRoot.create).toHaveBeenCalledWith(element)
	const first = reactRoot.render.mock.calls[0]?.[0] as ReactElement<GUIProps<CounterApp>>
	expect(first.type).toBe(Component)
	expect(first.props.state).toBe(initial)
	expect(first.props.dialog).toBeDefined()

	push({ count: 2 })
	const second = reactRoot.render.mock.calls[1]?.[0] as ReactElement<GUIProps<CounterApp>>
	expect(second.props.state).toEqual({ count: 2 })

	push({ count: 2 })
	expect(reactRoot.render).toHaveBeenCalledTimes(2)

	await mounted.unmount()
	expect(unsubscribe).toHaveBeenCalledOnce()
	expect(reactRoot.unmount).toHaveBeenCalledOnce()
})
