import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { expect, test } from 'vitest'
import { initialAttachedAgentState } from '../attached-agent'
import { createAttachedAgentStore } from './attached-agent'

test('persists panel state and serializes changes from separate windows', async () => {
	const fs = volume(memStore())
	const store = createAttachedAgentStore(fs)

	expect(await store.read()).toEqual(initialAttachedAgentState)
	await Promise.all([
		store.change('notes', { open: true }),
		store.change('files', { size: { sheet: 260, sidebar: 360 }, open: true })
	])

	expect(await createAttachedAgentStore(fs).read()).toEqual({
		size: { sheet: 260, sidebar: 360 },
		open: { notes: true, files: true }
	})
})

test('falls back when the saved file is corrupt', async () => {
	const fs = volume(memStore())
	await fs.mkdir('/private/shell', { recursive: true })
	await fs.writeFile('/private/shell/attached-agent.json', new TextEncoder().encode('{'))

	expect(await createAttachedAgentStore(fs).read()).toEqual(initialAttachedAgentState)
})
