import { describe, expect, test } from 'bun:test'
import { AuditLog } from './audit.ts'
import type { KvStorage } from './storage.ts'

function memStorage(): KvStorage {
	const map = new Map<string, unknown>()
	return {
		async get<T>(key: string) {
			return map.get(key) as T | undefined
		},
		async put<T>(key: string, value: T) {
			map.set(key, value)
		},
		async delete(key: string) {
			return map.delete(key)
		},
		async list<T>(opts?: { prefix?: string }) {
			const out = new Map<string, T>()
			for (const [key, value] of map) {
				if (!opts?.prefix || key.startsWith(opts.prefix)) {
					out.set(key, value as T)
				}
			}
			return out
		}
	}
}

describe('AuditLog', () => {
	test('append + list returns entries in chronological order', async () => {
		const log = new AuditLog(memStorage())
		await log.append({
			integrationId: 'fastmail',
			accountId: 'default',
			command: 'email',
			argv: ['list'],
			exitCode: 0
		})
		await log.append({
			integrationId: 'fastmail',
			accountId: 'default',
			command: 'email',
			argv: ['send'],
			exitCode: 1
		})
		const entries = await log.list()
		expect(entries).toHaveLength(2)
		expect(entries[0].argv).toEqual(['list'])
		expect(entries[1].argv).toEqual(['send'])
		expect(typeof entries[0].ts).toBe('number')
	})

	test('caps the list at 1000 entries', async () => {
		const log = new AuditLog(memStorage(), { max: 5 })
		for (let i = 0; i < 8; i++) {
			await log.append({
				integrationId: 'a',
				accountId: 'x',
				command: 'cmd',
				argv: [String(i)],
				exitCode: 0
			})
		}
		const entries = await log.list()
		expect(entries).toHaveLength(5)
		expect(entries.map((e) => e.argv[0])).toEqual(['3', '4', '5', '6', '7'])
	})
})
