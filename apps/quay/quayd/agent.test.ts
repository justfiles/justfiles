import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createQuayAgent, type QuayAgent } from './agent.ts'
import { createHost, type Host } from './host.ts'

// Legacy quayd agent (Slice 10). App control, shell, and file tools were removed
// when the daemon became the real agent host, so these cover only what survives
// offline (no model backend): the seeded soul, the slash-command catalogue, `/new`
// session reset, and reloading a prior conversation from the Volume.

let root: string
let host: Host
let agent: QuayAgent

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'quayd-agent-'))
	host = await createHost(root)
	agent = await createQuayAgent(host)
})
afterAll(async () => {
	await rm(root, { recursive: true, force: true })
})

function write(fs: Host['fs'], path: string, value: unknown): Promise<void> {
	return fs.writeFile(path, new TextEncoder().encode(JSON.stringify(value)))
}

function writeLines(fs: Host['fs'], path: string, lines: unknown[]): Promise<void> {
	const body = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
	return fs.writeFile(path, new TextEncoder().encode(body))
}

test('seeds a default soul so the agent skips frieren-style setup mode', async () => {
	const soul = new TextDecoder().decode(await host.fs.readFile('/system/soul.md'))
	expect(soul).toContain('quay')
	expect(soul.length).toBeGreaterThan(100)
})

test('`commands` lists the built-in /new (offline, no model backend)', async () => {
	const commands = await agent.commands()
	const names = commands.map((c) => c.name)
	expect(names).toContain('new')
	expect(commands.find((c) => c.name === 'new')?.kind).toBe('builtin')
})

test('/new starts a fresh session, clears the transcript, and keeps the old one on disk', async () => {
	const otherRoot = await mkdtemp(join(tmpdir(), 'quayd-agent-new-'))
	try {
		const otherHost = await createHost(otherRoot)
		const dir = '/system/agents/main/sessions'
		const oldFile = `${dir}/reload01.jsonl`
		await otherHost.fs.mkdir(dir, { recursive: true })
		await write(otherHost.fs, `${dir}/sessions.json`, {
			'agent:main': {
				sessionId: 'reload01',
				lastActive: new Date().toISOString(),
				sessionFile: oldFile
			}
		})
		await writeLines(otherHost.fs, oldFile, [
			{ id: 'aaaa0001', parentId: null, ts: '', type: 'message', role: 'user', content: 'hello' }
		])

		const fresh = await createQuayAgent(otherHost)
		expect(fresh.history().length).toBe(1)

		const cleared = await fresh.command('new')
		expect(cleared).toEqual([])
		expect(fresh.history()).toEqual([])

		// The index now points at a brand-new session…
		const index = JSON.parse(
			new TextDecoder().decode(await otherHost.fs.readFile(`${dir}/sessions.json`))
		) as { 'agent:main': { sessionId: string } }
		expect(index['agent:main'].sessionId).not.toBe('reload01')
		// …and the old transcript is untouched on disk (nothing deleted).
		expect(new TextDecoder().decode(await otherHost.fs.readFile(oldFile))).toContain('hello')
	} finally {
		await rm(otherRoot, { recursive: true, force: true })
	}
})

test('a fresh agent loads the previous conversation from the Volume session', async () => {
	const otherRoot = await mkdtemp(join(tmpdir(), 'quayd-agent-reload-'))
	try {
		const otherHost = await createHost(otherRoot)
		// Seed a recent session the way the runtime persists one: a sessions index
		// pointing at a JSONL transcript of one completed turn (within the 6h reuse
		// window so `route` reloads it rather than rolling over).
		const dir = '/system/agents/main/sessions'
		await otherHost.fs.mkdir(dir, { recursive: true })
		await write(otherHost.fs, `${dir}/sessions.json`, {
			'agent:main': {
				sessionId: 'reload01',
				lastActive: new Date().toISOString(),
				sessionFile: `${dir}/reload01.jsonl`
			}
		})
		await writeLines(otherHost.fs, `${dir}/reload01.jsonl`, [
			{ id: 'aaaa0001', parentId: null, ts: '', type: 'message', role: 'user', content: 'hello' },
			{
				id: 'aaaa0002',
				parentId: 'aaaa0001',
				ts: '',
				type: 'message',
				role: 'assistant',
				content: 'hi there'
			}
		])

		const reloaded = await createQuayAgent(otherHost)
		expect(reloaded.history().map((m) => ({ role: m.role, content: m.content }))).toEqual([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi there' }
		])
	} finally {
		await rm(otherRoot, { recursive: true, force: true })
	}
})
