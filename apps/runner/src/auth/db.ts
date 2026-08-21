type Value = string | number | null

interface Statement {
	sql: string
	values: Value[]
}

export interface Database {
	first<T>(sql: string, ...values: Value[]): Promise<T | null>
	run(sql: string, ...values: Value[]): Promise<number>
	batch(statements: Statement[]): Promise<number[]>
}

export const d1 = (database: D1Database): Database => ({
	first: <T>(sql: string, ...values: Value[]) =>
		database
			.prepare(sql)
			.bind(...values)
			.first<T>(),
	run: async (sql: string, ...values: Value[]) =>
		(
			await database
				.prepare(sql)
				.bind(...values)
				.run()
		).meta.changes,
	batch: async (statements: Statement[]) =>
		(
			await database.batch(
				statements.map(({ sql, values }) => database.prepare(sql).bind(...values))
			)
		).map((result) => result.meta.changes)
})
