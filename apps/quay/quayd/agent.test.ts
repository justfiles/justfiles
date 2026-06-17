import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createQuayAgent, type QuayAgent } from './agent.ts'
import { createHost, type Host } from './host.ts'

// Slice 10 acceptance — the agent in quayd, through quay's REAL wiring (kernel +
// nodeSandbox + native-FS Volume + the bash `app` command over the quay
// AppController). We exercise the controller via DIRECT commands (`app …`), which
// short-circuit the bash registry — no model backend, so this runs offline. Window
// ops are injected so `launch`/`close` don't touch LaunchServices.

const COUNTER = 'app.justfiles.counter'
let root: string
let host: Host
let agent: QuayAgent
const opened: Array<{ id: string; name: string }> = []
const closed: string[] = []

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'quayd-agent-'))
	host = await createHost(root)
	agent = await createQuayAgent(host, {
		open: (id, name) => opened.push({ id, name }),
		close: (name) => closed.push(name)
	})
})
afterAll(async () => {
	await rm(root, { recursive: true, force: true })
})

function reply(messages: { role: string; content: string }[]): string {
	return messages.at(-1)?.content ?? ''
}

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

test('`app list` reports the seeded built-ins without a model backend', async () => {
	const messages = await agent.prompt('app list')
	const last = messages.at(-1)
	expect(last?.role).toBe('assistant')
	expect(reply(messages)).toContain(COUNTER)
})

test('`app launch` opens the real bundle and becomes the current app', async () => {
	await agent.prompt(`app launch ${COUNTER}`)
	expect(opened.at(-1)?.id).toBe(COUNTER)

	// `current` now resolves to the launched app — `app run` with no --id targets it.
	const out = reply(await agent.prompt('app current'))
	expect(out).toContain(COUNTER)
})

test('`app run` dispatches into the same kernel a window subscribes to', async () => {
	await agent.prompt(`app run --id ${COUNTER} increment amount=2`)
	await agent.prompt(`app run --id ${COUNTER} increment amount=3`)
	expect((await host.kernel.state(COUNTER)) as { count: number }).toEqual({ count: 5 })
})

test('`app close` quits the current window by its bundle name', async () => {
	await agent.prompt('app close')
	// close targets the same app `launch` opened, addressed by its bundle name.
	expect(closed.at(-1)).toBe(opened.at(-1)?.name)
})

test('the transcript accumulates each turn', async () => {
	const before = agent.history().length
	await agent.prompt('app list')
	// One user + one assistant message per turn.
	expect(agent.history().length).toBe(before + 2)
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

		const fresh = await createQuayAgent(otherHost, { open: () => {}, close: () => {} })
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

		const reloaded = await createQuayAgent(otherHost, {
			open: () => {},
			close: () => {}
		})
		expect(reloaded.history().map((m) => ({ role: m.role, content: m.content }))).toEqual([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi there' }
		])
	} finally {
		await rm(otherRoot, { recursive: true, force: true })
	}
})
