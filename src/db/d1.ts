import { drizzle } from 'drizzle-orm/d1'
import type { DBClient } from '.'
import * as schema from './schema'

export function fromD1(d1: D1Database): DBClient {
	return drizzle(d1, { schema })
}
