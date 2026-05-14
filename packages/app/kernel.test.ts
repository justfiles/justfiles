import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { appBundleFromMemory, type GetSandbox, kernel } from './kernel'

const sandbox: GetSandbox = async function (code: string) {
	const mod = await import(`data:text/javascript;base64,${btoa(code)}`)
	return {
		run: async (action) => {
			const fn = mod[action.type]
			if (typeof fn !== 'function')
				throw new Error(`action type "${action.type}" is not a function`)
			return fn(action.params)
		}
	}
}

const clock = {}

test('install works', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox, clock })
	const app = appBundleFromMemory({
		name: 'app',
		fn: 'export function greet(params) { return "hello, " + params.name }'
	})
	const appId = await k.install(app)

	expect(appId).toBeTruthy()
	expect(await fs.exists('/applications/app/manifest.json')).toBe(true)
	const result = await k.dispatch({
		appId,
		actor: 'agent',
		action: { type: 'greet', params: { name: 'John' } }
	})

	expect(result).toBe('hello, John')
})
