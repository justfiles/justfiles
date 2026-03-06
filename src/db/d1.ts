import type { drizzle } from 'drizzle-orm/libsql'
import type * as schema from './schema'

export type DBClient = ReturnType<typeof drizzle<typeof schema>>

export function fromD1(d1: D1Database): DBClient {
	// TODO: implement db
	throw new Error('not implemented')
}
