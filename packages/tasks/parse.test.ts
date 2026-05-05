import { describe, expect, test } from 'bun:test'
import { decodeFilename, encodeFilename, isValidId, slugify } from './parse.ts'

describe('parse', () => {
	test('encode/decode round-trip without due', () => {
		const meta = { id: '20260505T101530', status: 'TODO', title: 'buy milk' }
		const filename = encodeFilename(meta)
		expect(filename).toBe('20260505T101530--TODO--buy-milk.md')
		const decoded = decodeFilename(filename)
		expect(decoded).toEqual({
			id: '20260505T101530',
			status: 'TODO',
			title: 'buy-milk'
		})
	})

	test('encode/decode round-trip with due', () => {
		const meta = {
			id: '20260505T101530',
			status: 'TODO',
			due: '20260615',
			title: 'buy milk'
		}
		const filename = encodeFilename(meta)
		expect(filename).toBe('20260505T101530--TODO--20260615--buy-milk.md')
		const decoded = decodeFilename(filename)
		expect(decoded).toEqual({
			id: '20260505T101530',
			status: 'TODO',
			due: '20260615',
			title: 'buy-milk'
		})
	})

	test('encode → decode → encode is stable (with due)', () => {
		const meta = {
			id: '20260505T101530',
			status: 'DONE',
			due: '20260101',
			title: 'finish report'
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
		expect(() => encodeFilename({ id: 'bad', status: 'TODO', title: 'x' })).toThrow()
	})

	test('encodeFilename rejects invalid due', () => {
		expect(() =>
			encodeFilename({ id: '20260505T101530', status: 'TODO', due: '2026-06-15', title: 'x' })
		).toThrow()
	})

	test('encodeFilename prefixes a bare-8-digit title', () => {
		const filename = encodeFilename({ id: '20260505T101530', status: 'TODO', title: '20260120' })
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
	})

	test('decodeFilename handles due with multi-segment title', () => {
		const decoded = decodeFilename('20260505T101530--TODO--20260615--foo--bar.md')
		expect(decoded?.due).toBe('20260615')
		expect(decoded?.title).toBe('foo--bar')
	})
})
