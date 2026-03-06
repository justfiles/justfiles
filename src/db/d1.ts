import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export type DBClient = ReturnType<typeof drizzle<typeof schema>>

export function fromD1(d1: D1Database): DBClient {
	return drizzle(d1, { schema })
}
