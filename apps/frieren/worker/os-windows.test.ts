import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, test } from 'vitest'
import { currentAppId, readWindows } from './os-windows.ts'

// The single reader of `/system/os-state.json` (#284 §6): one walk, two projections —
// `readWindows` for the agent's `os windows`, `currentAppId` for the app bridge's focus.
async function seed(snapshot?: unknown) {
	const fs = volume(memStore())
	if (snapshot !== undefined) {
		await fs.mkdir('/system', { recursive: true })
		await fs.writeFile(
			'/system/os-state.json',
			new TextEncoder().encode(typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot))
		)
	}
	return fs
}

const OPEN = {
	windows: {
		'app.a': { id: 'app.a', kind: 'app', appId: 'app.a', title: 'A', mode: 'floating' },
		'app.b': { id: 'app.b', kind: 'app', appId: 'app.b', title: 'B', mode: 'minimized' },
		agent: { id: 'agent', kind: 'agent', mode: 'floating' }
	},
	openOrder: ['app.a', 'app.b', 'agent'],
	focusStack: ['app.b', 'agent', 'app.a']
}

describe('readWindows', () => {
	test('projects the snapshot in focus order, most recent first', async () => {
		expect(await readWindows(await seed(OPEN))).toEqual([
			{ appId: 'app.a', title: 'A', focused: true },
			{ title: 'agent', focused: false },
			{ appId: 'app.b', title: 'B', focused: false, minimized: true }
		])
	})

	test('falls back to open order when no focus is recorded', async () => {
		const fs = await seed({ ...OPEN, focusStack: [] })
		expect((await readWindows(fs)).map((w) => w.appId ?? w.title)).toEqual([
			'agent',
			'app.b',
			'app.a'
		])
	})

	test('an absent, corrupt or empty snapshot reads as no windows', async () => {
		expect(await readWindows(await seed())).toEqual([])
		expect(await readWindows(await seed('{not json'))).toEqual([])
		expect(await readWindows(await seed({ windows: {}, openOrder: [], focusStack: [] }))).toEqual(
			[]
		)
	})
})

describe('currentAppId', () => {
	test('is the frontmost APP — the chat window presents none', async () => {
		const fs = await seed({ ...OPEN, focusStack: ['app.a', 'agent'] })
		expect(await currentAppId(fs)).toBe('app.a')
	})

	test('is undefined with no app window open', async () => {
		const fs = await seed({
			windows: { agent: { id: 'agent', kind: 'agent', mode: 'floating' } },
			openOrder: ['agent'],
			focusStack: ['agent']
		})
		expect(await currentAppId(fs)).toBeUndefined()
	})
})
