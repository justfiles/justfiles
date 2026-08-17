// Devkit install/preview coverage — build & install through the
// daemon's REAL wiring: `buildKernel` (kernel + reducer sandbox pool + the `devkit`
// capability whose compile/typecheck run in the daemon's toolchain worker) over a throwaway
// temp Volume. We drive Code (`justfiles.code`) the way its GUI does — create a project, open it,
// install — and assert the freshly-built app lands in the SAME catalog the launcher lists,
// then that `run` installs a hidden, servable preview that `stop` tears down. Bun-only
// (`bun test`): the reducer sandbox uses blob-URL Workers and the toolchain worker compiles
// with `Bun.build`. Needs the network: Code is not seeded, so the run installs it from
// JustApps first, exactly as the App Store tile does.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kernel, Message } from '@justfiles/app/runtime'
import { volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { buildKernel, daemonAccounts } from './kernel.ts'
import { sandboxes } from './sandbox.ts'
import { installStoreApp, storeCatalog } from './store.ts'

const CODE = 'justfiles.code'
const NEW_APP = 'demo.widget'
let root: string
let kernel: Kernel

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'daemon-devkit-'))
	const fs = volume(await nativeStorage(root))
	kernel = await buildKernel(fs, daemonAccounts(fs))
	// Install Code the way the store tile does: browse, then install the exact version listed.
	const code = (await storeCatalog()).find((app) => app.id === CODE)
	if (!code) throw new Error('justfiles.code is not published')
	await installStoreApp(kernel, CODE, code.version)
})
afterAll(async () => {
	await rm(root, { recursive: true, force: true })
})

const dispatch = (type: string, params: object): Promise<unknown> =>
	kernel.dispatch(CODE, { type, params } as Message)

test('Code builds and installs a project into the kernel catalog', async () => {
	sandboxes.retain(CODE) // pin its reducer worker the way an open window would

	// Author a tiny project (Code seeds a buildable React starter), open it so the
	// reducer carries its slug, then ship it through the toolchain worker.
	const { slug } = (await dispatch('create', { name: 'Demo Widget', id: NEW_APP })) as {
		slug: string
	}
	expect(slug).toBe(NEW_APP)
	await dispatch('open', { slug })
	const installed = (await dispatch('install', {})) as { id: string }
	expect(installed.id).toBe(NEW_APP)

	// The compiled bundle is now a real entry in the canonical catalog — exactly where
	// the launcher (and Spotlight, via the projection) reads from.
	const list = await kernel.list()
	expect(list.some((app) => app.id === NEW_APP)).toBe(true)

	sandboxes.release(CODE)
}, 60_000)

test('Code runs a project as a hidden, servable preview that stop tears down', async () => {
	sandboxes.retain(CODE)
	const previewId = `.preview.${NEW_APP}`

	// The project from the previous test is still open (its slug on the reducer), so
	// `run` compiles it and installs it under `.preview.*` in the SAME kernel. The
	// daemon's runner points the preview at the app shell over http.
	const run = (await dispatch('run', {})) as { preview?: { kind: string; src: string } }
	expect(run.preview).toEqual({ kind: 'url', src: `/app/${encodeURIComponent(previewId)}` })
	// The preview is a hidden id: off the launcher catalog, yet installed and servable by
	// exact id — its gui.js reads, so app-code's iframe mounts it via the app shell.
	expect((await kernel.list()).some((app) => app.id === previewId)).toBe(false)
	expect(await (await kernel.app(previewId)).read('gui.js')).toBeInstanceOf(Uint8Array)

	// stop uninstalls it (moving the bundle to /trash), so it's no longer addressable by id.
	await dispatch('stop', {})
	await expect(kernel.app(previewId)).rejects.toThrow()

	sandboxes.release(CODE)
}, 60_000)
