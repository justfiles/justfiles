// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0001 from './0001_schema.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0002 from './0002_path_sync.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0003 from './0003_drop_legacy_delta.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0004 from './0004_generation.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0005 from './0005_lineage_id.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0006 from './0006_reset_operation.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0007 from './0007_journal_path.sql'
// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0008 from './0008_tombstone_index.sql'

export type MigrationEntry = {
	version: number
	sql: string
}

export const coreMigrations: MigrationEntry[] = [
	{ version: 1, sql: MIGRATION_0001 },
	{ version: 2, sql: MIGRATION_0002 },
	{ version: 3, sql: MIGRATION_0003 },
	{ version: 4, sql: MIGRATION_0004 },
	{ version: 5, sql: MIGRATION_0005 },
	{ version: 6, sql: MIGRATION_0006 },
	{ version: 7, sql: MIGRATION_0007 },
	{ version: 8, sql: MIGRATION_0008 }
]
