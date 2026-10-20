import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { StateDatabase } from '../types.ts'

/** A `StateDatabase` over `node:sqlite` in WAL mode; `":memory:"` keeps nothing. */
export function openNodeSqliteState(path: string): Promise<StateDatabase> {
	return openNodeSqliteDatabase(path)
}
