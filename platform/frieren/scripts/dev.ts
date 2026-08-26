import { type ChildProcess, spawn } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDevStore } from './dev-store.ts'

const root = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)))
const customApps = process.env.VITE_FRIEREN_DEV_APP_STORE || process.env.FRIEREN_DEV_APPS

async function main(): Promise<void> {
	if (customApps) return runFrieren()

	const apps = await appRoots()
	let watch: ChildProcess | undefined
	if (!(await buildsReady(apps))) {
		watch = start(['exec', 'turbo', 'watch', 'build', '--filter=./apps/*', '--ui=stream'])
		await waitForBuilds(apps, watch)
	}
	const store = await startDevStore(apps.map((app) => join(app, 'dist')))
	console.log(`\n  ➜  Dev app store: ${store.url}`)

	watch ??= start(['exec', 'turbo', 'watch', 'build', '--filter=./apps/*', '--ui=stream'])
	const frieren = start(['exec', 'turbo', 'run', 'dev', '--filter=frieren', '--ui=stream'], {
		...process.env,
		VITE_FRIEREN_DEV_APP_STORE: store.url
	})
	const { child, code } = await Promise.race([exited(watch), exited(frieren)])
	for (const running of [watch, frieren]) if (running !== child) running.kill('SIGTERM')
	await store.close()
	process.exitCode = code
}

async function appRoots(): Promise<string[]> {
	const apps = join(root, 'apps')
	const entries = await readdir(apps, { withFileTypes: true })
	const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(apps, entry.name))
	const found = await Promise.all(
		dirs.map(async (dir) =>
			access(join(dir, 'package.json'))
				.then(() => dir)
				.catch(() => null)
		)
	)
	return found.filter((dir): dir is string => dir !== null)
}

async function waitForBuilds(apps: string[], watch: ChildProcess): Promise<void> {
	while (!(await buildsReady(apps))) {
		if (watch.exitCode !== null || watch.signalCode)
			throw new Error(`turbo watch exited with ${watch.exitCode ?? watch.signalCode}`)
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
}

async function buildsReady(apps: string[]): Promise<boolean> {
	const found = await Promise.all(
		apps.map((app) =>
			access(join(app, 'dist', 'manifest.json'))
				.then(() => true)
				.catch(() => false)
		)
	)
	return found.every(Boolean)
}

async function runFrieren(): Promise<void> {
	const child = start(['exec', 'turbo', 'run', 'dev', '--filter=frieren', '--ui=stream'])
	process.exitCode = (await exited(child)).code
}

function start(args: string[], env = process.env): ChildProcess {
	return spawn('pnpm', args, { cwd: root, env, stdio: 'inherit' })
}

function exited(child: ChildProcess): Promise<{ child: ChildProcess; code: number }> {
	if (child.exitCode !== null || child.signalCode)
		return Promise.resolve({ child, code: child.exitCode ?? 1 })
	return new Promise((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', (code) => resolve({ child, code: code ?? 1 }))
	})
}

void main()
