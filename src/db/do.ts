import { drizzle } from 'drizzle-orm/durable-sqlite'
import type { DBClient } from '.'
import * as schema from './schema'

export function fromDO(storage: DurableObjectStorage): DBClient {
	return drizzle(storage, { schema })
}
