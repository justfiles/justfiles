import { chroot, memStorage, volume } from '@justfiles/fs'
import * as esbuild from 'esbuild'
import { unzipSync } from 'fflate'
import { beforeAll, describe, expect, test } from 'vitest'
import { buildDraft, installDraft, packDraft, type Toolchain } from './devkit.ts'
import { buildRuntime } from './devkit-runtime.ts'
import { type GetSandbox, kernel } from './kernel.ts'

// End-to-end coverage of the draft pipeline against the REAL toolchain: write a
// project into a data volume, then buildDraft / packDraft / installDraft it. The
// kernel never runs the app (install only writes /applications), so a stub
// sandbox suffices.

const enc = new TextEncoder()
const APP_ID = 'app.author'
const SLUG = 'draft'

const PROJECT = JSON.stringify({
	id: 'app.example.drafted',
	name: 'Drafted',
	app: 'app.ts',
	gui: 'gui.ts'
})
const APP = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'
export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({ increment: t.on(v.object({}), (s) => ({ count: s.count + 1 })) })
})`
const GUI = `import { defineGUI } from '@justfiles/app/browser'
export const gui = defineGUI({ mount(el) { return { update() {}, unmount() {} } } })`

const stubSandbox: GetSandbox = async () => ({ run: async () => ({ result: null }) })

async function seedProject(): Promise<ReturnType<typeof volume>> {
	const fs = volume(memStorage())
	const root = `/data/${APP_ID}/projects/${SLUG}`
	await fs.mkdir(root, { recursive: true })
	await fs.writeFile(`${root}/project.json`, enc.encode(PROJECT))
	await fs.writeFile(`${root}/app.ts`, enc.encode(APP))
	await fs.writeFile(`${root}/gui.ts`, enc.encode(GUI))
	return fs
}

describe('devkit draft pipeline', () => {
	let tc: Toolchain
	beforeAll(async () => {
		tc = { build: esbuild.build, runtime: await buildRuntime() }
	}, 30_000)

	test('buildDraft compiles the project from its data volume', async () => {
		const fs = await seedProject()
		const draft = await buildDraft(chroot(fs, `/data/${APP_ID}`), SLUG, tc)
		expect(draft.diagnostics).toEqual([])
		expect(draft.manifest.id).toBe('app.example.drafted')
		expect(draft.app).toContain('dispatch')
		expect(draft.gui.length).toBeGreaterThan(0)
	})

	test('packDraft emits a zip with manifest + compiled entries', async () => {
		const fs = await seedProject()
		const { zip } = await packDraft(chroot(fs, `/data/${APP_ID}`), SLUG, tc)
		const entries = unzipSync(zip)
		expect(Object.keys(entries).sort()).toEqual(['app.js', 'gui.js', 'manifest.json'])
		const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']))
		expect(manifest).toMatchObject({ id: 'app.example.drafted', app: 'app.js', gui: 'gui.js' })
	})

	test('installDraft promotes to /applications and rejects a colliding id', async () => {
		const fs = await seedProject()
		const k = kernel({ fs, sandbox: stubSandbox, clock: {} })
		const onInstalled: string[] = []
		const { id } = await installDraft(fs, APP_ID, SLUG, k, tc, {
			onInstalled: () => void onInstalled.push('hit')
		})
		expect(id).toBe('app.example.drafted')
		expect((await k.list()).map((m) => m.id)).toContain('app.example.drafted')
		expect(onInstalled).toEqual(['hit'])
		// install only ever creates — re-shipping the same id is rejected.
		await expect(installDraft(fs, APP_ID, SLUG, k, tc)).rejects.toThrow(/already exists/)
		// …unless `overwrite` is set, which updates the live app in place.
		await expect(installDraft(fs, APP_ID, SLUG, k, tc, { overwrite: true })).resolves.toMatchObject(
			{ id: 'app.example.drafted' }
		)
		expect((await k.list()).filter((m) => m.id === 'app.example.drafted')).toHaveLength(1)
	})
})
