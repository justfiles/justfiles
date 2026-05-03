import { describe, expect, test } from 'bun:test'
import { type Command, CommandRegistry } from './registry.ts'

function stub(name: string, summary = `${name} summary`): Command {
	return {
		name,
		summary,
		async run() {
			return { stdout: '', stderr: '', exitCode: 0 }
		}
	}
}

describe('CommandRegistry', () => {
	test('register + lookup', () => {
		const r = new CommandRegistry()
		const cmd = stub('echo')
		r.register(cmd)
		expect(r.lookup('echo')).toBe(cmd)
	})

	test('lookup of missing command returns undefined', () => {
		const r = new CommandRegistry()
		expect(r.lookup('nope')).toBeUndefined()
	})

	test('registering same name twice throws', () => {
		const r = new CommandRegistry()
		r.register(stub('echo'))
		expect(() => r.register(stub('echo'))).toThrow(/already registered/)
	})

	test('unregister removes the command', () => {
		const r = new CommandRegistry()
		r.register(stub('echo'))
		r.unregister('echo')
		expect(r.lookup('echo')).toBeUndefined()
	})

	test('list returns command summaries sorted by name', () => {
		const r = new CommandRegistry()
		r.register(stub('mv', 'move'))
		r.register(stub('cp', 'copy'))
		expect(r.list()).toEqual([
			{ name: 'cp', summary: 'copy' },
			{ name: 'mv', summary: 'move' }
		])
	})
})
