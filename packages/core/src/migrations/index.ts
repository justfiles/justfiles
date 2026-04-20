// biome-ignore lint/suspicious/noTsIgnore: TypeScript cannot resolve bundler-loaded .sql imports in this package.
// @ts-ignore Bundlers load SQL as text for this package.
import MIGRATION_0001 from './0001_schema.sql'

export type MigrationEntry = {
	version: number
	sql: string
}

export const coreMigrations: MigrationEntry[] = [{ version: 1, sql: MIGRATION_0001 }]
