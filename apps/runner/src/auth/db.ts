type Value = string | number | null

export interface Database {
	first<T>(sql: string, ...values: Value[]): Promise<T | null>
	run(sql: string, ...values: Value[]): Promise<number>
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
		).meta.changes
})
