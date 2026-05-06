import { describe, expect, test } from 'bun:test'
import { decodeFilename, encodeFilename, isValidId, slugify } from './parse.ts'

describe('parse', () => {
	test('encode/decode round-trip without due', () => {
		const meta = { id: '20260505T101530', status: 'TODO', title: 'buy milk', tags: [] }
		const filename = encodeFilename(meta)
		expect(filename).toBe('20260505T101530--TODO--buy-milk.md')
		const decoded = decodeFilename(filename)
		expect(decoded).toEqual({
			id: '20260505T101530',
			status: 'TODO',
			title: 'buy-milk',
			tags: []
		})
	})

	test('encode/decode round-trip with due', () => {
		const meta = {
			id: '20260505T101530',
			status: 'TODO',
			due: '20260615',
			title: 'buy milk',
			tags: []
		}
		const filename = encodeFilename(meta)
		expect(filename).toBe('20260505T101530--TODO--20260615--buy-milk.md')
		const decoded = decodeFilename(filename)
		expect(decoded).toEqual({
			id: '20260505T101530',
			status: 'TODO',
			due: '20260615',
			title: 'buy-milk',
			tags: []
		})
	})

	test('encode/decode round-trip with tags', () => {
		const meta = {
			id: '20260505T101530',
			status: 'TODO',
			title: 'buy milk',
			tags: ['work', 'urgent']
		}
		const filename = encodeFilename(meta)
		expect(filename).toBe('20260505T101530--TODO--buy-milk__work__urgent.md')
		const decoded = decodeFilename(filename)
		expect(decoded).toEqual({
			id: '20260505T101530',
			status: 'TODO',
			title: 'buy-milk',
			tags: ['work', 'urgent']
		})
	})

	test('encode/decode round-trip with priority', () => {
		const meta = {
			id: '20260505T101530',
			status: 'TODO',
			title: 'buy milk',
			tags: [],
			priority: 1 as const
		}
		const filename = encodeFilename(meta)
		expect(filename).toBe('20260505T101530--TODO--buy-milk__p1.md')
		const decoded = decodeFilename(filename)
		expect(decoded).toEqual({
			id: '20260505T101530',
			status: 'TODO',
			title: 'buy-milk',
			tags: [],
			priority: 1
		})
	})

	test('encode/decode round-trip with tags and priority', () => {
		const meta = {
			id: '20260505T101530',
			status: 'TODO',
			due: '20260615',
			title: 'pay bill',
			tags: ['finance', 'chore'],
			priority: 2 as const
		}
		const filename = encodeFilename(meta)
		expect(filename).toBe('20260505T101530--TODO--20260615--pay-bill__finance__chore__p2.md')
		const decoded = decodeFilename(filename)
		expect(decoded).toEqual({
			id: '20260505T101530',
			status: 'TODO',
			due: '20260615',
			title: 'pay-bill',
			tags: ['finance', 'chore'],
			priority: 2
		})
	})

	test('encode → decode → encode is stable (with due)', () => {
		const meta = {
			id: '20260505T101530',
			status: 'DONE',
			due: '20260101',
			title: 'finish report',
			tags: []
		}
		const first = encodeFilename(meta)
		const decoded = decodeFilename(first)
		if (!decoded) throw new Error('decode failed')
		const second = encodeFilename(decoded)
		expect(second).toBe(first)
	})

	test('encode → decode → encode is stable (with tags and priority)', () => {
		const meta = {
			id: '20260505T101530',
			status: 'TODO',
			title: 'fix bug',
			tags: ['work'],
			priority: 3 as const
		}
		const first = encodeFilename(meta)
		const decoded = decodeFilename(first)
		if (!decoded) throw new Error('decode failed')
		const second = encodeFilename(decoded)
		expect(second).toBe(first)
	})

	test('slugify lowercases and hyphenates', () => {
		expect(slugify('Hello World')).toBe('hello-world')
		expect(slugify('Foo, Bar! Baz?')).toBe('foo-bar-baz')
		expect(slugify('   spaces   ')).toBe('spaces')
		expect(slugify('')).toBe('untitled')
	})

	test('slugify guards bare 8-digit titles', () => {
		expect(slugify('20260120')).toBe('task-20260120')
		expect(slugify('  20260120  ')).toBe('task-20260120')
	})

	test('isValidId accepts denote-style timestamps', () => {
		expect(isValidId('20260505T101530')).toBe(true)
		expect(isValidId('20260505T101530-1')).toBe(true)
		expect(isValidId('not-a-timestamp')).toBe(false)
		expect(isValidId('2026-05-05')).toBe(false)
	})

	test('encodeFilename rejects invalid id', () => {
		expect(() => encodeFilename({ id: 'bad', status: 'TODO', title: 'x', tags: [] })).toThrow()
	})

	test('encodeFilename rejects invalid due', () => {
		expect(() =>
			encodeFilename({ id: '20260505T101530', status: 'TODO', due: '2026-06-15', title: 'x', tags: [] })
		).toThrow()
	})

	test('encodeFilename prefixes a bare-8-digit title', () => {
		const filename = encodeFilename({ id: '20260505T101530', status: 'TODO', title: '20260120', tags: [] })
		expect(filename).toBe('20260505T101530--TODO--task-20260120.md')
		const decoded = decodeFilename(filename)
		expect(decoded?.due).toBeUndefined()
		expect(decoded?.title).toBe('task-20260120')
	})

	test('decodeFilename returns null for non-md files', () => {
		expect(decodeFilename('20260505T101530--TODO--x.txt')).toBeNull()
	})

	test('decodeFilename returns null for malformed names', () => {
		expect(decodeFilename('not-a-task.md')).toBeNull()
		expect(decodeFilename('20260505T101530--TODO.md')).toBeNull()
		expect(decodeFilename('--TODO--title.md')).toBeNull()
	})

	test('decodeFilename preserves unknown status values', () => {
		const decoded = decodeFilename('20260505T101530--WAITING--something.md')
		expect(decoded?.status).toBe('WAITING')
	})

	test('decodeFilename handles titles containing the separator', () => {
		const decoded = decodeFilename('20260505T101530--TODO--foo--bar.md')
		expect(decoded?.title).toBe('foo--bar')
		expect(decoded?.due).toBeUndefined()
		expect(decoded?.tags).toEqual([])
	})

	test('decodeFilename handles due with multi-segment title', () => {
		const decoded = decodeFilename('20260505T101530--TODO--20260615--foo--bar.md')
		expect(decoded?.due).toBe('20260615')
		expect(decoded?.title).toBe('foo--bar')
		expect(decoded?.tags).toEqual([])
	})

	test('decodeFilename parses tags from multi-segment title with tokens', () => {
		const decoded = decodeFilename('20260505T101530--TODO--foo--bar__work__p1.md')
		expect(decoded?.title).toBe('foo--bar')
		expect(decoded?.tags).toEqual(['work'])
		expect(decoded?.priority).toBe(1)
	})
})
