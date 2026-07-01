import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@justfiles/app/runtime'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createHost, type Host } from './host.ts'

// Slice 11 acceptance — build & install via devkit, through quay's REAL wiring: the
// kernel + a nodeSandbox worker_thread + the in-process `devkit` capability (native
// esbuild + the pre-bundled system runtime). We drive Code (`app.code`) the way its
// GUI does — create a project, open it, then install — and assert the freshly-built
// app lands in the SAME `/applications` the launcher lists, with no app-code change.

const CODE = 'app.code'
const NEW_APP = 'demo.widget'
let root: string
let host: Host

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'quayd-devkit-'))
	host = await createHost(root)
})
afterAll(async () => {
	await rm(root, { recursive: true, force: true })
})

const dispatch = (type: string, params: object): Promise<unknown> =>
	host.kernel.dispatch(CODE, { type, params } as Message)

test('Code builds and installs a project into the kernel catalog', async () => {
	host.sandbox.retain(CODE) // pin its reducer worker the way an open window would

	// Author a tiny project (Code seeds a buildable React starter), open it so the
	// reducer carries its slug, then ship it.
	const { slug } = (await dispatch('create', { name: 'Demo Widget', id: NEW_APP })) as {
		slug: string
	}
	expect(slug).toBe(NEW_APP)
	await dispatch('open', { slug })
	const installed = (await dispatch('install', {})) as { id: string }
	expect(installed.id).toBe(NEW_APP)

	// The compiled bundle is now a real entry in the canonical, syncable catalog —
	// exactly where the launcher (and Spotlight, via the projection) reads from.
	const list = await host.kernel.list()
	expect(list.some((app) => app.id === NEW_APP)).toBe(true)

	host.sandbox.release(CODE)
}, 60_000)

test('Code runs a project as a hidden, servable preview that stop tears down', async () => {
	host.sandbox.retain(CODE)
	const previewId = `.preview.${NEW_APP}`

	// The project from the previous test is still open (its slug on the reducer), so
	// `run` compiles it and installs it under `.preview.*` in the SAME kernel.
	const run = (await dispatch('run', {})) as { preview?: { kind: string; src: string } }
	expect(run.preview).toEqual({ kind: 'url', src: `/app/${encodeURIComponent(previewId)}` })
	// The preview is a hidden id: off the launcher catalog, yet installed and servable
	// by exact id — its gui.js reads, so app-code's iframe mounts it via the app shell.
	expect((await host.kernel.list()).some((app) => app.id === previewId)).toBe(false)
	expect(await (await host.kernel.app(previewId)).read('gui.js')).toBeInstanceOf(Uint8Array)

	// stop uninstalls it, so the bundle is gone entirely — no longer addressable.
	await dispatch('stop', {})
	await expect(host.kernel.app(previewId)).rejects.toThrow()

	host.sandbox.release(CODE)
}, 60_000)
