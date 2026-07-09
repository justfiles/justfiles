// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0001 from './0001_schema.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0002 from './0002_path_sync.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0003 from './0003_drop_legacy_delta.sql'

export type MigrationEntry = {
	version: number
	sql: string
}

export const coreMigrations: MigrationEntry[] = [
	{ version: 1, sql: MIGRATION_0001 },
	{ version: 2, sql: MIGRATION_0002 },
	{ version: 3, sql: MIGRATION_0003 }
]
