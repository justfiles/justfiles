import { describe, expect, it } from 'vitest'
import { type DialogClient, type DialogRequest, defineGUI } from './browser.ts'
import type { Transport } from './sdk.ts'

// A GUI harness with no DOM: `defineGUI` only forwards the element, so a stub is
// enough to observe what the app's `update` is actually called with.
function mountGUI(initial: unknown) {
	const rendered: unknown[] = []
	let push!: (state: unknown) => void
	const transport: Transport = {
		invoke: async () => undefined,
		subscribe: (onState) => {
			push = onState
			return () => {}
		}
	}
	const gui = defineGUI<never>({
		mount: (_el, state) => {
			rendered.push(state)
			return { update: (next) => void rendered.push(next), unmount: () => {} }
		}
	})
	gui.mount(null as unknown as HTMLElement, initial as never, {
		transport,
		dialog: { request: async () => undefined }
	})
	return { rendered, push: (state: unknown) => push(state) }
}

it('injects the typed dialog client and maps each method to a host request', async () => {
	const requests: DialogRequest[] = []
	const results: unknown[] = [undefined, true, 'keep-both']
	let dialog!: DialogClient
	const gui = defineGUI<never>({
		mount: (_el, _state, context) => {
			dialog = context.dialog
			return { update() {}, unmount() {} }
		}
	})
	gui.mount(null as unknown as HTMLElement, null, {
		transport: { invoke: async () => undefined, subscribe: () => () => {} },
		dialog: {
			request: async (request) => {
				requests.push(request)
				return results[requests.length - 1]
			}
		}
	})

	await dialog.alert({ title: 'Done' })
	expect(
		await dialog.confirm({ title: 'Delete?', confirmLabel: 'Delete', destructive: true })
	).toBe(true)
	expect(
		await dialog.choose({
			title: 'File exists',
			actions: [
				{ id: 'cancel', label: 'Cancel', role: 'cancel' },
				{ id: 'replace', label: 'Replace', role: 'destructive' },
				{ id: 'keep-both', label: 'Keep Both' }
			]
		})
	).toBe('keep-both')
	expect(requests).toEqual([
		{ kind: 'alert', title: 'Done' },
		{ kind: 'confirm', title: 'Delete?', confirmLabel: 'Delete', destructive: true },
		{
			kind: 'choose',
			title: 'File exists',
			actions: [
				{ id: 'cancel', label: 'Cancel', role: 'cancel' },
				{ id: 'replace', label: 'Replace', role: 'destructive' },
				{ id: 'keep-both', label: 'Keep Both' }
			]
		}
	])
})

describe('defineGUI state pushes', () => {
	it('drops a push that decided nothing, so the app never re-renders', () => {
		// The host pushes across a structured-clone boundary, so an unchanged state
		// still arrives as fresh objects — the shape a no-op sync wake produces.
		const { rendered, push } = mountGUI({ openPath: null, revision: 3, files: [{ path: '/a' }] })
		push({ openPath: null, revision: 3, files: [{ path: '/a' }] })
		push({ openPath: null, revision: 3, files: [{ path: '/a' }] })
		expect(rendered).toHaveLength(1)
	})

	it('renders a real change', () => {
		const { rendered, push } = mountGUI({ revision: 0 })
		push({ revision: 1 })
		expect(rendered).toHaveLength(2)
		expect(rendered[1]).toEqual({ revision: 1 })
	})

	it('keeps the identity of branches the change did not touch', () => {
		const files = [{ path: '/a' }, { path: '/b' }]
		const { rendered, push } = mountGUI({ files, currentViewing: null })
		push({ files: [{ path: '/a' }, { path: '/b' }], currentViewing: '/a' })
		const next = rendered[1] as { files: unknown[]; currentViewing: string }
		// The selection moved; the file list did not — so an effect keyed on it must
		// not re-run, which is only true if the array is the SAME reference.
		expect(next.currentViewing).toBe('/a')
		expect(next.files).toBe(files)
	})

	it('sees an added, removed or reordered key as a change', () => {
		const { rendered, push } = mountGUI({ a: 1 })
		push({ a: 1, b: 2 })
		push({ a: 1 })
		push({ a: 1, b: undefined })
		expect(rendered).toEqual([{ a: 1 }, { a: 1, b: 2 }, { a: 1 }, { a: 1, b: undefined }])

		// Same key count, and every value reads as `undefined` through `prev[key]` —
		// only presence tells the two apart.
		const swap = mountGUI({ a: undefined })
		swap.push({ b: undefined })
		expect(swap.rendered).toHaveLength(2)
		expect(Object.keys(swap.rendered[1] as object)).toEqual(['b'])

		const list = mountGUI({ items: ['a', 'b'] })
		list.push({ items: ['b', 'a'] })
		list.push({ items: ['b'] })
		expect(list.rendered).toEqual([{ items: ['a', 'b'] }, { items: ['b', 'a'] }, { items: ['b'] }])
	})

	it('never confuses an array with an object', () => {
		const { rendered, push } = mountGUI({ value: [] })
		push({ value: {} })
		expect(rendered[1]).toEqual({ value: {} })
		expect(Array.isArray((rendered[1] as { value: unknown }).value)).toBe(false)
	})

	it('drops a null push onto a null state, and renders the first real one', () => {
		const { rendered, push } = mountGUI(null)
		push(null)
		expect(rendered).toHaveLength(1)
		push({ openPath: null })
		expect(rendered).toHaveLength(2)
	})
})
