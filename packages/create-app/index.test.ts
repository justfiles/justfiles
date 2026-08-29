import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const cli = fileURLToPath(new URL('./index.js', import.meta.url))
const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('uses the vanilla template by default', () => {
	const { root, result } = run(['counter'])

	expect(result.status).toBe(0)
	expect(existsSync(join(root, 'counter/src/gui.ts'))).toBe(true)
	expect(existsSync(join(root, 'counter/src/gui.tsx'))).toBe(false)
})

test('creates a React app', () => {
	const { root, result } = run(['--template', 'react', 'counter'])
	const dir = join(root, 'counter')

	expect(result.status).toBe(0)
	const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	expect(readFileSync(join(dir, 'src/gui.tsx'), 'utf8')).toContain('defineReactGUI<CounterApp>')
	expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain('react()')
	expect(pkg.dependencies.react).toBe('^19')
	expect(existsSync(join(dir, 'src/gui.ts'))).toBe(false)
})

test('rejects an unknown template', () => {
	const { root, result } = run(['counter', '--template=vue'])

	expect(result.status).toBe(1)
	expect(result.stderr).toContain('Unknown template: vue. Choose vanilla or react.')
	expect(existsSync(join(root, 'counter'))).toBe(false)
})

function run(args: string[]) {
	const root = mkdtempSync(join(tmpdir(), 'create-app-'))
	roots.push(root)
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
	return { root, result }
}
