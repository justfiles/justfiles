import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import type { Kernel } from '../../kernel.ts'
import { sdkRuntimeSpecs } from '../../runtime-specs.ts'
import { DEVKIT_SCHEMA } from './devkit-sysroot.ts'
import { devkitCapability, noopRunner } from './host.ts'
import type { CompileResult } from './toolchain.ts'

// Step 5: the devkit factory is caller-aware. The shared `devkitCapability`
// pipeline threads the calling app's id (`ctx.appId`) into every method, so it
// loads THAT caller's own sysroot via `kernel().app(ctx.appId)` rather than a
// hardcoded one. These tests pin the threading — we only prove the right appId
// reaches the kernel resolution.

const enc = new TextEncoder()
const empty: CompileResult = { outputs: [], diagnostics: [] }

// Seed a trivial project for `appId` so `readProject` (which runs before the
// toolchain is reached) succeeds — we only care which appId the factory gets.
async function seed(fs: ReturnType<typeof volume>, appId: string, slug: string): Promise<void> {
	const root = `/data/${appId}/projects/${slug}`
	await fs.mkdir(root, { recursive: true })
	await fs.writeFile(
		`${root}/project.json`,
		enc.encode(JSON.stringify({ id: 'app.x', name: 'X', app: 'app.ts' }))
	)
	await fs.writeFile(`${root}/app.ts`, enc.encode('export const app = {}'))
}

// A devkit capability whose fake kernel records every app id the factory resolves a
// sysroot for. `read` serves a stub devkit sysroot so loadRuntime/loadTypes succeed;
// the compile/typecheck backends return empty results — we only care which appId
// reaches `kernel().app()`. The runtime map lists every SDK spec (pointing at one
// empty blob), because `loadRuntime` rejects an incomplete sysroot.
const STUB = 'stub'
function harness() {
	const fs = volume(memStorage())
	const seen: string[] = []
	const index = enc.encode(
		JSON.stringify({
			schema: DEVKIT_SCHEMA,
			hash: 'x',
			files: {},
			runtime: Object.fromEntries(sdkRuntimeSpecs.map((spec) => [`${spec}.js`, STUB])),
			paths: {}
		})
	)
	const read = async (path: string) => {
		if (path === 'devkit/index.json') return index
		if (path === `devkit/store/${STUB}`) return enc.encode('export {}')
		throw new Error(`not found: ${path}`)
	}
	const kernel = {
		app: async (appId: string) => {
			seen.push(appId)
			return { read }
		}
	} as unknown as Kernel
	const impl = devkitCapability({
		fs,
		kernel,
		compile: async () => empty,
		typecheck: async () => ({ diagnostics: [] }),
		runner: noopRunner
	})
	const call = (appId: string, method: string, args: readonly unknown[]) =>
		impl.invoke({ appId, capability: 'devkit', method, args, scopes: [] })
	return { fs, seen, call }
}

test('compile resolves the toolchain for the calling app', async () => {
	const { fs, seen, call } = harness()
	await seed(fs, 'app.justfiles.frieren.code', 'draft')
	await call('app.justfiles.frieren.code', 'compile', [{ slug: 'draft' }])
	expect(seen).toEqual(['app.justfiles.frieren.code'])
})

test('each caller resolves its own toolchain — no hardcoded app id', async () => {
	const { fs, seen, call } = harness()
	await seed(fs, 'app.justfiles.frieren.code', 'a')
	await seed(fs, 'app.other', 'b')
	await call('app.justfiles.frieren.code', 'compile', [{ slug: 'a' }])
	await call('app.other', 'typecheck', [{ slug: 'b' }])
	expect(seen).toEqual(['app.justfiles.frieren.code', 'app.other'])
})
