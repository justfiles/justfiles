// `coreMigrations` is the list the DO actually applies, and nothing else in the
// suite reads it: the storage tests build their schema by reading this directory
// off disk, so a migration can be exercised in full while the export that ships
// it is broken. That is not hypothetical — 0010 landed as `0010_path_index.sql`
// while index.ts still imported the name it had in the previous commit, and only
// `vite build` noticed.
//
// Neither of the usual nets reaches this. The compiler cannot: every `.sql` import
// carries a suppression comment, because TS has no way to resolve a bundler-loaded
// one. Importing the module here cannot either: vitest has no `.sql` loader. So the
// source is read as text and held to the directory, which is the drift the bundler
// would have caught.

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationsDir = new URL('./', import.meta.url)

const sqlFiles = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()

const source = readFileSync(new URL('./index.ts', migrationsDir), 'utf8')
const imported = [...source.matchAll(/^import\s+\w+\s+from\s+'\.\/(.+\.sql)'$/gm)].map((m) => m[1])

describe('coreMigrations', () => {
	it('imports a file that exists, for every migration in the directory', () => {
		// Both directions: an import naming a file that was renamed away breaks the
		// worker bundle, and a `.sql` added without registering it never runs.
		expect(imported).toEqual(sqlFiles)
	})

	it('numbers each entry to match its filename', () => {
		expect(imported.map((f, i) => [f.slice(0, 4), i + 1])).toEqual(
			imported.map((_, i) => [String(i + 1).padStart(4, '0'), i + 1])
		)
	})
})
