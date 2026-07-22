import type { AppController, AppInspection } from '@justfiles/app'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import { createAppCommand } from './app.ts'
import { createJustBashTool } from './index.ts'

// Drive the `app` command through the REAL just-bash shell (not a hand-parsed
// argv), because the failure this guards against is the shell's own tokenization:
// an inline JSON value is unquoted, so its quotes are stripped before the command
// ever sees it. A fake controller stands in for the kernel — it validates the one
// action shape the tests care about.
const PIXEL = 'computer.spud.pixel'

function inspect(id: string): AppInspection {
	return {
		id,
		name: 'Pixel',
		state: { grid: ['..', '..'] },
		actions: {
			setPixels: {
				kind: 'handler',
				description: 'Place many pixels at once.',
				schemaHint: { pixels: 'array' },
				examples: [{ params: { pixels: [{ x: 0, y: 0, i: 1 }] } }]
			},
			setColorIndex: {
				kind: 'handler',
				description: 'Set the active palette index.',
				schemaHint: { i: 'number' },
				examples: [{ params: { i: 6 } }]
			},
			clear: { kind: 'handler', description: 'Clear the canvas.', examples: [{ params: {} }] }
		}
	}
}

// Rejects anything that isn't the declared shape, like a real valibot schema — so
// a param the shell mangled into a string surfaces as APP_VALIDATION_FAILED, and a
// well-formed one round-trips.
function fakeController(): AppController {
	return {
		list: async () => [{ id: PIXEL, name: 'Pixel' }],
		launch: async (id) => inspect(id),
		close: async () => {},
		current: async () => undefined,
		inspect: async (id) => inspect(id),
		state: async (id) => inspect(id).state,
		run: async (_id, action, params) => {
			const p = params as Record<string, unknown>
			if (action === 'setPixels' && !Array.isArray(p.pixels))
				throw new Error('Invalid type: expected array but received string')
			if (action === 'setColorIndex' && typeof p.i !== 'number')
				throw new Error('Invalid type: expected number')
			return { ...inspect(PIXEL).state, applied: action }
		}
	}
}

async function runShell(command: string): Promise<{ text: string; exitCode: number }> {
	const tool = createJustBashTool({
		volume: volume(memStorage()),
		commands: [createAppCommand(fakeController())]
	})
	const r = await tool.execute('1', { command })
	return { text: r.content[0]?.text ?? '', exitCode: (r.details as { exitCode: number }).exitCode }
}

describe('app run — structured params through the shell', () => {
	test('inline array param the agent over-escapes fails with a discoverable error', async () => {
		// Exactly what the acceptance run produced: single-quoted, backslash-escaped
		// JSON. The shell keeps the backslashes; JSON.parse throws; we surface it.
		const { text, exitCode } = await runShell(
			String.raw`app run --id ${PIXEL} setPixels pixels='[{\"x\":0,\"y\":0,\"i\":1}]'`
		)
		expect(exitCode).toBe(1)
		expect(text).toContain('BAD_PARAMS')
		expect(text).toContain('--params-json') // the fix is in the error itself
		// The failing action's usage + examples ride the error so the agent can self-correct.
		expect(text).toContain('setPixels')
	})

	test('inline array without escaping also fails (the shell eats the quotes)', async () => {
		const { text, exitCode } = await runShell(
			`app run --id ${PIXEL} setPixels pixels=[{"x":0,"y":0,"i":1}]`
		)
		expect(exitCode).toBe(1)
		expect(text).toContain('--params-json')
	})

	test('--params-json round-trips and dispatches', async () => {
		const { text, exitCode } = await runShell(
			`app run --id ${PIXEL} setPixels --params-json '{"pixels":[{"x":0,"y":0,"i":1}]}'`
		)
		expect(exitCode).toBe(0)
		expect(text).toContain('"applied": "setPixels"')
	})

	test('malformed --params-json reports the robust single-quoted form', async () => {
		const { text, exitCode } = await runShell(
			`app run --id ${PIXEL} setPixels --params-json '{"pixels":[{"x":}]}'`
		)
		expect(exitCode).toBe(1)
		expect(text).toContain('BAD_PARAMS')
		expect(text).toContain('--params-json')
	})

	test('scalar key=value still works', async () => {
		const { text, exitCode } = await runShell(`app run --id ${PIXEL} setColorIndex i=6`)
		expect(exitCode).toBe(0)
		expect(text).toContain('"applied": "setColorIndex"')
	})

	test('a schema rejection returns the action usage + examples', async () => {
		// Passes validation-time (parses to a string) but the controller rejects it.
		const { text, exitCode } = await runShell(`app run --id ${PIXEL} setColorIndex i=notanumber`)
		expect(exitCode).toBe(1)
		expect(text).toContain('APP_VALIDATION_FAILED')
		expect(text).toContain('setColorIndex')
	})
})

describe('app actions/examples advertise the shell-safe form', () => {
	test('a structured example renders as --params-json, a scalar one as key=value', async () => {
		const { text } = await runShell(`app actions --id ${PIXEL}`)
		// `app actions` prints JSON, so the example's inner quotes are escaped in the dump.
		expect(text).toContain(`app run --id ${PIXEL} setPixels --params-json`)
		expect(text).toContain(`app run --id ${PIXEL} setColorIndex i=6`)
	})

	test('unknown action lists available actions with runnable examples', async () => {
		const { text, exitCode } = await runShell(`app run --id ${PIXEL} setPixel i=1`)
		expect(exitCode).toBe(1)
		expect(text).toContain('UNKNOWN_ACTION')
		expect(text).toContain('setPixels')
		expect(text).toContain('--params-json')
	})
})
