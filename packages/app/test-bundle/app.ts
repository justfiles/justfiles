import * as v from 'valibot'
import { defineCapability } from '../capabilities/core.ts'
import { volume } from '../capabilities/volume/index.ts'
import { defineApp } from '../sdk.ts'

interface TestCapability {
	echo(input: { text: string }): Promise<{ text: string }>
}

const test = defineCapability<'test', TestCapability>('test')

export const app = defineApp({
	init: { count: 0 },
	capabilities: { test: test({ scopes: [] }), volume: volume({ scopes: ['app'] }) },
	update: (t) => ({
		increment: t.on(v.object({ amount: v.number() }), (state, { amount }) => ({
			...state,
			count: state.count + amount
		})),
		// Effects ride as command data: write the note via the volume capability,
		// then fold the (void) result back leaving state untouched.
		write: t.on(v.object({ text: v.string() }), (state, { text }) => [
			state,
			t.cmd(
				'volume',
				'writeFile',
				{ path: '/note.txt', data: new TextEncoder().encode(text) },
				'written'
			)
		]),
		written: t.fromResult('volume', 'writeFile', (state) => state),
		// Echo capability: the result edge replaces count with the echoed length.
		ask: t.on(v.object({ text: v.string() }), (state, { text }) => [
			state,
			t.cmd('test', 'echo', { text }, 'asked')
		]),
		asked: t.fromResult('test', 'echo', (state, r) =>
			r.ok ? { count: r.value.text.length } : state
		)
	})
})
