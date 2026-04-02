// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0001 from './0001_schema.sql'
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0002 from './0002_dirty_flag.sql'
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0003 from './0003_drop_chunk_vectors.sql'
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0004 from './0004_reset_dirty.sql'
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0005 from './0005_fs_schema.sql'
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0006 from './0006_fs_updates_source.sql'

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
	{ version: 6, sql: MIGRATION_0006 }
]
