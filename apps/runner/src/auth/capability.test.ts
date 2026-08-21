import { expect, test } from 'vitest'
import { appAccess } from './capability'

test('hashes a stable sorted set of capability ids and scopes', async () => {
	const first = await appAccess('alice.notes', {
		files: { id: 'volume', scopes: ['app', 'app'] },
		writer: { id: 'ai', scopes: [] }
	})
	const same = await appAccess('alice.notes', {
		namedDifferently: { id: 'ai', scopes: [] },
		storage: { id: 'volume', scopes: ['app'] }
	})
	const changed = await appAccess('alice.notes', {
		storage: { id: 'volume', scopes: [] }
	})

	expect(first).toEqual({
		hash: same.hash,
		resources: ['ai', 'volume:app']
	})
	expect(changed.hash).not.toBe(first.hash)
})

test('permits full volume access only for Files', async () => {
	expect(
		await appAccess('justfiles.files', { volume: { id: 'volume', scopes: ['system'] } })
	).toMatchObject({ resources: ['volume:system'] })
	await expect(
		appAccess('alice.notes', { volume: { id: 'volume', scopes: ['system'] } })
	).rejects.toThrow('volume scope')
})

test('rejects absolute volume prefixes and AI learning context', async () => {
	for (const scope of ['/', '/shared'])
		await expect(
			appAccess('alice.notes', { volume: { id: 'volume', scopes: [scope] } })
		).rejects.toThrow('volume scope')
	await expect(
		appAccess('alice.notes', { ai: { id: 'ai', scopes: ['context:learning'] } })
	).rejects.toThrow('AI scope')
})
