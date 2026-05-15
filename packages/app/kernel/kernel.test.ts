import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { appBundleFromMemory } from './app'
import { type GetSandbox, kernel } from './kernel'
import code from './kernel.testapp.js?raw'

const sandbox: GetSandbox = async function (code: string) {
	const mod = await import(`data:text/javascript;base64,${btoa(code)}`)
	const app = mod.app
	if (typeof app !== 'object') {
		throw new Error(`app module must export an object named "app"`)
	}

	return {
		run: async (action, ctx) => await app.dispatch(action, ctx)
	}
}

const clock = {}

test('smoke test kernel', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox, clock })
	const app = appBundleFromMemory({
		name: 'app',
		fn: code
	})
	const appId = await k.install(app)

	expect(appId).toBeTruthy()
	expect(await fs.exists('/applications/app/manifest.json')).toBe(true)
	let result = await k.dispatch(appId, {
		type: 'increment',
		params: { amount: 5 },
		actor: 'agent'
	})

	expect(result).toEqual({ count: 5 })

	result = await k.dispatch(appId, {
		type: 'increment',
		params: { amount: 2 },
		actor: 'agent'
	})

	expect(result).toEqual({ count: 7 })
})
