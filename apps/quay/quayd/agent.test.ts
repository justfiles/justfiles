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
