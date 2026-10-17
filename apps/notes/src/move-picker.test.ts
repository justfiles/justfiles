import { describe, expect, test } from 'vitest'
import { folderPathInput } from './move-picker.tsx'

describe('folderPathInput', () => {
	test.each([
		['Trips', '/Trips'],
		['/Trips', '/Trips'],
		[' Travel/Japan/ ', '/Travel/Japan']
	])('turns %j into a canonical folder path', (input, expected) => {
		expect(folderPathInput(input)).toBe(expected)
	})

	test.each(['', '/', '.', '..', '../Trips', 'Trips//Japan', 'Trips\\Japan'])(
		'refuses %j',
		(input) => {
			expect(folderPathInput(input)).toBeNull()
		}
	)
})
