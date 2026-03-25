declare module 'bun:sqlite' {
	type SqlValue = null | string | number | bigint | Uint8Array | ArrayBuffer

	export class Database {
		constructor(path: string)
		exec(sql: string): void
		prepare(sql: string): {
			all(...args: SqlValue[]): unknown[]
			run(...args: SqlValue[]): void
		}
	}
}
