import type { drizzle } from 'drizzle-orm/durable-sqlite'
import type * as schema from './schema'
export type DBClient = ReturnType<typeof drizzle<typeof schema>>

export { fromDO } from './do'
