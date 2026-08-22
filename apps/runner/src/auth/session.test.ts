import { expect, test } from 'vitest'
import { createSession, readSession, takeTicket } from './session'
import { addAccount, testDatabase } from './test-db'

test('stores only the session hash and reads a live app session', async () => {
	const { database, sqlite } = testDatabase()
	await addAccount(database)
	const session = await createSession(
		database,
		{ kind: 'app', userId: 'user_1', appId: 'alice.notes' },
		1_000
	)
	const stored = sqlite.prepare('SELECT id_hash FROM sessions').get() as { id_hash: string }

	expect(session.id).toHaveLength(43)
	expect(session.requestNonce).toHaveLength(43)
	expect(stored.id_hash).not.toBe(session.id)
	expect(await readSession(database, session.id, 'app', 1_001)).toMatchObject({
		kind: 'app',
		userId: 'user_1',
		appId: 'alice.notes',
		requestNonce: session.requestNonce
	})
})

test('a ticket cannot cross apps and can be used once', async () => {
	const { database } = testDatabase()
	await addAccount(database)
	const ticket = await createSession(
		database,
		{ kind: 'ticket', userId: 'user_1', appId: 'alice.notes' },
		1_000
	)

	expect(await takeTicket(database, ticket.id, 'bob.tasks', 1_001)).toBeNull()
	expect(await takeTicket(database, ticket.id, 'alice.notes', 1_001)).toMatchObject({
		kind: 'ticket',
		userId: 'user_1',
		appId: 'alice.notes'
	})
	expect(await takeTicket(database, ticket.id, 'alice.notes', 1_001)).toBeNull()
})

test('does not return an expired session or ticket', async () => {
	const { database } = testDatabase()
	await addAccount(database)
	const root = await createSession(database, { kind: 'root', userId: 'user_1' }, 1_000)
	const ticket = await createSession(
		database,
		{ kind: 'ticket', userId: 'user_1', appId: 'alice.notes' },
		1_000
	)

	expect(await readSession(database, root.id, 'root', root.expiresAt)).toBeNull()
	expect(await takeTicket(database, ticket.id, 'alice.notes', ticket.expiresAt)).toBeNull()
})
