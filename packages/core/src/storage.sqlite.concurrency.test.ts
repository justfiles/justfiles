// Overlapping mutations through the REAL storage, over the real `createSqliteAdapter`
// (#339). The unit-level faces of this are in db.sqlite.test.ts; these are the ones a user
// would hit.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'

// Apply every migration in order (0001, 0002, …) exactly as the DO does via
// coreMigrations — so path-sync tables are present in the test DB too.
const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))
	.join('\n')

function makeSqlite() {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const db64 = {
		prepare(sql: string) {
			const stmt = db.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => db.exec(sql)
	}
	return sqliteStorage(
		createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
	)
}

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

// #339 end to end: the adapter's queue is what lets two overlapping mutations through the
// real storage. Two PLAIN renames — nothing exotic, no flag — were enough to make the second
// one fail with "cannot start a transaction within a transaction", and the loser's rollback
// could take the winner's row with it.
test('two concurrent renames both complete, and neither loses the other', async () => {
	const vol = volume(makeSqlite())
	await vol.mkdir('/Inbox')
	await vol.writeFile('/Inbox/a.md', bytes('a'))
	await vol.writeFile('/Inbox/b.md', bytes('b'))
	const results = await Promise.allSettled([
		vol.rename('/Inbox/a.md', '/x.md'),
		vol.rename('/Inbox/b.md', '/y.md')
	])
	expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
	expect(text(await vol.readFile('/x.md'))).toBe('a')
	expect(text(await vol.readFile('/y.md'))).toBe('b')
	expect((await vol.readdir('/Inbox')).map((e) => e.name)).toEqual([])
})

test('a batch of concurrent writes all land', async () => {
	// The create path never collided — its transaction bodies happen not to yield in the wrong
	// place — which is exactly why it is worth pinning: the difference between "safe" and
	// "lucky" here was one `await` in a helper, and this test is what notices if it moves.
	const vol = volume(makeSqlite())
	await Promise.all(
		Array.from({ length: 12 }, (_, i) => vol.writeFile(`/n${i}.md`, bytes(`note ${i}`)))
	)
	const names = (await vol.readdir('/')).map((e) => e.name).sort()
	expect(names).toHaveLength(12)
	for (let i = 0; i < 12; i++) expect(text(await vol.readFile(`/n${i}.md`))).toBe(`note ${i}`)
})
