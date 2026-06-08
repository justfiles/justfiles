import { expect, test } from 'vitest'
import { app, type CodeState, isCodeState } from './app.ts'

// Slice 11 (code, interim): the watch is wired (refactor), but the product
// decision on how to reconcile an external change is deferred — for now a foreign
// change is surfaced loudly (a throw → app error) and the editor's own saves are
// ignored, so nothing is silently reloaded or overwritten.

const base: CodeState = {
	slug: 'demo',
	name: 'Demo',
	selectedPath: 'app.ts',
	view: 'app',
	files: ['app.ts'],
	sourceHash: 'h',
	build: null
}

test('declares a watch on the open source file, none when nothing is selected', () => {
	expect(app.subscriptions(base)).toEqual([
		{
			capability: 'volume',
			method: 'watch',
			args: [{ path: '/projects/demo/src/app.ts' }],
			to: 'fileChanged'
		}
	])
	expect(app.subscriptions({ ...base, selectedPath: null })).toEqual([])
})

test('a foreign on-disk change is surfaced loudly, not silently applied', async () => {
	await expect(
		app.dispatch({ type: '__sub/fileChanged', params: { source: 'remote' } }, { state: base })
	).rejects.toThrow(/changed on disk outside the editor/)
})

test("the editor's own saves (no source) are ignored", async () => {
	const out = await app.dispatch({ type: '__sub/fileChanged', params: {} }, { state: base })
	expect(out.state).toEqual(base)
})

test('close returns to the gallery (slug null)', async () => {
	const out = await app.dispatch({ type: 'close', params: {} }, { state: base })
	expect(out.state?.slug).toBeNull()
})

test('no watch subscription when no project is open', () => {
	expect(app.subscriptions({ ...base, slug: null })).toEqual([])
})

test('isCodeState requires name, so a pre-name persisted state is rebuilt', () => {
	expect(isCodeState({ slug: 'x', files: [], view: 'app' })).toBe(false)
})
