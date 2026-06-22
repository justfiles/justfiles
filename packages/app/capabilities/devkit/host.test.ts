import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import type { CompileResult, Toolchain } from '../../toolchain.ts'
import { devkitCapability, noopRunner } from './host.ts'

// Step 5: the toolchain factory is caller-aware. The shared `devkitCapability`
// pipeline threads the calling app's id (`ctx.appId`) into the `toolchain`
// factory on every method, so a host can load THAT caller's own types sysroot
// rather than a hardcoded one. These tests pin the threading — the per-app header
// READ is Step 6; here we only prove the right appId reaches the seam.

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

// A devkit capability whose toolchain factory records every caller it sees.
function harness() {
	const fs = volume(memStorage())
	const seen: string[] = []
	const tc: Toolchain = { compile: async () => empty, typecheck: async () => ({ diagnostics: [] }) }
	const impl = devkitCapability({
		fs,
		toolchain: async (ctx) => {
			seen.push(ctx.appId)
			return tc
		},
		runner: noopRunner,
		kernel: () => {
			throw new Error('kernel not needed')
		}
	})
	const call = (appId: string, method: string, args: readonly unknown[]) =>
		impl.invoke({ appId, capability: 'devkit', method, args, scopes: [] })
	return { fs, seen, call }
}

test('compile resolves the toolchain for the calling app', async () => {
	const { fs, seen, call } = harness()
	await seed(fs, 'app.code', 'draft')
	await call('app.code', 'compile', [{ slug: 'draft' }])
	expect(seen).toEqual(['app.code'])
})

test('each caller resolves its own toolchain — no hardcoded app id', async () => {
	const { fs, seen, call } = harness()
	await seed(fs, 'app.code', 'a')
	await seed(fs, 'app.other', 'b')
	await call('app.code', 'compile', [{ slug: 'a' }])
	await call('app.other', 'typecheck', [{ slug: 'b' }])
	expect(seen).toEqual(['app.code', 'app.other'])
})
