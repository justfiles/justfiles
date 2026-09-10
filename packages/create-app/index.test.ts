import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const cli = fileURLToPath(new URL('./index.js', import.meta.url))
const cliPackage = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
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

test.each(['vanilla', 'react'])('creates an installable %s package', (template) => {
	const { root, result } = run(['counter', '--template', template])
	const dir = join(root, 'counter')

	expect(result.status).toBe(0)
	const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'))
	expect(pkg.dependencies['@justfiles/app']).toBe(cliPackage.devDependencies['@justfiles/app'])
	expect(JSON.stringify({ pkg, tsconfig })).not.toMatch(/(?:workspace|catalog):/)
	expect(JSON.stringify({ pkg, tsconfig })).not.toContain('@justfiles/tsconfig')
	expect(tsconfig.compilerOptions).toMatchObject({
		lib: ['ES2023', 'DOM'],
		moduleResolution: 'bundler',
		strict: true
	})
	expect(tsconfig.include).toContain('vite.config.ts')
	for (const file of [
		'AGENTS.md',
		'CLAUDE.md',
		'README.md',
		'biome.json',
		'src/app.test.ts',
		'.gitignore'
	]) {
		expect(existsSync(join(dir, file)), file).toBe(true)
	}
	expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').trim()).toBe('@AGENTS.md')
	expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain("id: 'local.counter'")
	expect(result.stdout).toContain('AGENTS.md')
	for (const script of ['format', 'lint', 'typecheck', 'test', 'build', 'check']) {
		expect(pkg.scripts[script], script).toBeTruthy()
	}
})

test.each(['vanilla', 'react'])('sets the %s app identity without prompts', (template) => {
	const { root, result } = run(['My Notes', '--template', template, '--id', 'alice.notes'])
	const dir = join(root, 'My Notes')

	expect(result.status).toBe(0)
	expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name).toBe('my-notes')
	const config = readFileSync(join(dir, 'vite.config.ts'), 'utf8')
	expect(config).toContain("id: 'alice.notes'")
	expect(config).toContain("name: 'my-notes'")
	expect(config).not.toContain('__APP_')
})

test('accepts --id=owner.app', () => {
	const { root, result } = run(['counter', '--id=alice.counter'])

	expect(result.status).toBe(0)
	expect(readFileSync(join(root, 'counter/vite.config.ts'), 'utf8')).toContain(
		"id: 'alice.counter'"
	)
})

test.each([
	'--id',
	'--id=',
	'--id=counter',
	'--id=Alice.counter',
	"--id=alice.counter'bad"
])('rejects invalid %s before overwriting files', (option) => {
	const { root, result } = run(['counter', '--force', option], (root) => {
		mkdirSync(join(root, 'counter'))
		writeFileSync(join(root, 'counter/keep.txt'), 'keep')
	})

	expect(result.status).toBe(1)
	expect(result.stderr).toContain('Invalid app id')
	expect(readFileSync(join(root, 'counter/keep.txt'), 'utf8')).toBe('keep')
})

test('refuses to overwrite an existing app without --force', () => {
	const { root, result } = run(['counter'], (root) => {
		mkdirSync(join(root, 'counter'))
		writeFileSync(join(root, 'counter/AGENTS.md'), 'custom instructions')
	})

	expect(result.status).toBe(1)
	expect(readFileSync(join(root, 'counter/AGENTS.md'), 'utf8')).toBe('custom instructions')
})

function run(args: string[], setup?: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), 'create-app-'))
	roots.push(root)
	setup?.(root)
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
	return { root, result }
}
