import { type Volume, volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import { createBashTool } from '../index.ts'
import { type CommandContext, CommandRegistry } from '../registry.ts'
import { cp, mv, rm } from './fs.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function makeVol(): Volume {
	return volume(memStorage())
}

function ctxFor(vol: Volume): CommandContext {
	return { vol }
}

async function readText(vol: Volume, path: string): Promise<string> {
	return decoder.decode(await vol.readFile(path))
}

describe('cp', () => {
	test('copies file contents', async () => {
		const vol = makeVol()
		await vol.writeFile('/a', encoder.encode('hello'))
		const result = await cp.run(['/a', '/b'], ctxFor(vol))
		expect(result.exitCode).toBe(0)
		expect(await readText(vol, '/b')).toBe('hello')
		expect(await readText(vol, '/a')).toBe('hello')
	})

	test('missing source fails with exit 1 and mentions the path', async () => {
		const vol = makeVol()
		const result = await cp.run(['/missing', '/b'], ctxFor(vol))
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain('/missing')
	})

	test('refuses to overwrite existing destination without --force', async () => {
		const vol = makeVol()
		await vol.writeFile('/a', encoder.encode('new'))
		await vol.writeFile('/b', encoder.encode('old'))
		const result = await cp.run(['/a', '/b'], ctxFor(vol))
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain('/b')
		expect(await readText(vol, '/b')).toBe('old')
	})

	test('overwrites existing destination with --force', async () => {
		const vol = makeVol()
		await vol.writeFile('/a', encoder.encode('new'))
		await vol.writeFile('/b', encoder.encode('old'))
		const result = await cp.run(['/a', '/b', '--force'], ctxFor(vol))
		expect(result.exitCode).toBe(0)
		expect(await readText(vol, '/b')).toBe('new')
	})
})

describe('mv', () => {
	test('moves a file: original gone, destination has content', async () => {
		const vol = makeVol()
		await vol.writeFile('/a', encoder.encode('hello'))
		const result = await mv.run(['/a', '/b'], ctxFor(vol))
		expect(result.exitCode).toBe(0)
		expect(await vol.exists('/a')).toBe(false)
		expect(await readText(vol, '/b')).toBe('hello')
	})

	test('missing source fails with exit 1', async () => {
		const vol = makeVol()
		const result = await mv.run(['/missing', '/b'], ctxFor(vol))
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain('/missing')
	})
})

describe('rm', () => {
	test('removes a file', async () => {
		const vol = makeVol()
		await vol.writeFile('/a', encoder.encode('hello'))
		const result = await rm.run(['/a'], ctxFor(vol))
		expect(result.exitCode).toBe(0)
		expect(await vol.exists('/a')).toBe(false)
	})

	test('missing path fails with exit 1', async () => {
		const vol = makeVol()
		const result = await rm.run(['/missing'], ctxFor(vol))
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain('/missing')
	})

	test('plain rm on a directory fails with exit 1 and suggests -r', async () => {
		const vol = makeVol()
		await vol.mkdir('/dir')
		const result = await rm.run(['/dir'], ctxFor(vol))
		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain('-r')
		expect(await vol.exists('/dir')).toBe(true)
	})

	test('rm -r recurses into a directory', async () => {
		const vol = makeVol()
		await vol.mkdir('/dir')
		await vol.writeFile('/dir/a', encoder.encode('hi'))
		const result = await rm.run(['-r', '/dir'], ctxFor(vol))
		expect(result.exitCode).toBe(0)
		expect(await vol.exists('/dir')).toBe(false)
	})
})

describe('integration with bash tool', () => {
	test('bash dispatch round-trips cp', async () => {
		const vol = makeVol()
		await vol.writeFile('/a', encoder.encode('hello'))
		const registry = new CommandRegistry()
		registry.register(cp)
		const tool = createBashTool(registry, ctxFor(vol))
		const result = await tool.execute('id', { command: 'cp /a /b' })
		expect(result.details).toMatchObject({ exitCode: 0 })
		expect(await readText(vol, '/b')).toBe('hello')
	})

	test('bash dispatch returns rendered help for cp --help', async () => {
		const vol = makeVol()
		const registry = new CommandRegistry()
		registry.register(cp)
		const tool = createBashTool(registry, ctxFor(vol))
		const result = await tool.execute('id', { command: 'cp --help' })
		const text = result.content
			.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
			.map((c) => c.text)
			.join('')
		expect(text).toContain('usage:')
		expect(text).toContain('cp')
		expect(text).toContain('--force')
	})
})
