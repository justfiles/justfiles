import { describe, expect, test } from 'bun:test'
import { ParseError, parse } from './parser.ts'

describe('parse', () => {
	test('splits a simple command', () => {
		expect(parse('cp a b')).toEqual(['cp', 'a', 'b'])
	})

	test('preserves double-quoted strings with spaces', () => {
		expect(parse('echo "hi there"')).toEqual(['echo', 'hi there'])
	})

	test('preserves single-quoted strings with spaces', () => {
		expect(parse("mv 'with spaces' dst")).toEqual(['mv', 'with spaces', 'dst'])
	})

	test('returns empty array for empty input', () => {
		expect(parse('')).toEqual([])
		expect(parse('   ')).toEqual([])
	})

	test('throws ParseError on mismatched double quote', () => {
		expect(() => parse('echo "unterminated')).toThrow(ParseError)
	})

	test('throws ParseError on mismatched single quote', () => {
		expect(() => parse("echo 'unterminated")).toThrow(ParseError)
	})

	test('handles quoted token adjacent to unquoted text', () => {
		expect(parse('cmd a"b c"d')).toEqual(['cmd', 'ab cd'])
	})

	test('collapses runs of whitespace', () => {
		expect(parse('a   b\tc')).toEqual(['a', 'b', 'c'])
	})
})
