import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const packages = [
	['Code', '../../../../packages/app-code/package.json'],
	['Draw', '../../../../packages/app-draw/package.json']
] as const

describe('first-party publisher metadata', () => {
	for (const [name, path] of packages) {
		test(`${name} is discoverable and described on npm`, () => {
			const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
				description?: string
				keywords?: string[]
			}
			expect(pkg.keywords).toContain('kodama-app')
			expect(pkg.description?.trim()).toBeTruthy()
		})
	}
})
