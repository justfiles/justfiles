import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { type AuthPrompt, createModels, type Models } from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { openGhost, type ShellRecord } from '@justfiles/ghost'
import { openNodeSqliteState } from '@justfiles/ghost/state/node-sqlite'
import { volumeCredentials } from './credentials.ts'
import { type Login, serve } from './daemon.ts'
import { shellDir, socketPath } from './paths.ts'
import { createQuick } from './quick.ts'
import { readSettings, volumeRoot } from './settings.ts'
import { bashTool } from './tools/bash.ts'
import { loadCustomTools, withCustomTools } from './tools/custom.ts'
import { emacsTool } from './tools/emacs.ts'
import { openTool } from './tools/open.ts'

// pi-ai loads its sign-in flows from files beside its own, which the bundle does not have;
// these imports put them in it.
registerBunOAuthFlows()

/** Run the daemon until it goes idle. Returns at once when another daemon holds the lock. */
export async function main(): Promise<void> {
	const dir = shellDir()
	await mkdir(dir, { recursive: true, mode: 0o700 })
	const release = lock(join(dir, 'lock'))
	if (release === undefined) return
	try {
		const path = await loginPath()
		if (path !== undefined) process.env.PATH = path
		const shell = await shellRecord(join(dir, 'shell.json'))
		const settings = readSettings(dir)
		const { model: modelId = DEFAULT_MODEL, consolidate } = settings
		// The credentials live in the Volume's private mount, which the ghost's Volume leaves
		// unbound: the agent's files never include them.
		const privateRoot = join(volumeRoot(settings), 'private')
		await mkdir(privateRoot, { recursive: true, mode: 0o700 })
		const models = createModels({
			credentials: volumeCredentials(volume(fsStore(privateRoot)), '/ghost/credentials.json')
		})
		models.setProvider(openaiProvider())
		models.setProvider(openaiCodexProvider())
		const provider = await chatgpt(models)
		if (models.getModel(provider, modelId) === undefined) {
			const offered = models.getModels(provider).map((model) => model.id)
			throw new Error(
				`${provider} has no model ${modelId}; settings.json can name ${offered.join(', ')}`
			)
		}
		// Resolved, so that `bash` sees the same paths `pwd` prints.
		const root = await realpath(volumeRoot(settings))
		const ghost = await openGhost({
			volume: volume(fsStore(root, { mounts: ['private'] })),
			state: await openNodeSqliteState(join(dir, 'state.sqlite')),
			models,
			shell,
			// The user's own tools, from `tools/` beside settings.json, take the place of these by name.
			tools: withCustomTools(
				[bashTool({ root, denied: await realpath(privateRoot) }), emacsTool(root), openTool(root)],
				await loadCustomTools(join(dir, 'tools'), { root })
			),
			settings: { model: { provider, modelId }, consolidate }
		})
		const login: Login = async (device, notify, signal) => {
			await models.login(
				device ? 'openai-codex' : 'openai',
				'oauth',
				{ signal, notify, prompt: answer },
				{ getDeviceId: () => shell.id, agentName: 'ghost' }
			)
			// The ghost's model names its provider; the next daemon opens it with the new one.
			return (await chatgpt(models)) !== provider
		}
		const stop = new AbortController()
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort())
		await serve(ghost, socketPath(dir), {
			signal: stop.signal,
			login,
			quick: createQuick(models, provider, modelId)
		})
	} finally {
		release()
	}
}

/**
 * The model when `settings.json` in the shell directory names none. Sign in with ChatGPT
 * takes only the GPT-5.6 and GPT-6 models of `openai`'s list; an API key takes them too.
 */
const DEFAULT_MODEL = 'gpt-6.1-sol'

/**
 * The PATH of the user's login shell, so the machine tools find the user's programs. The
 * daemon has the environment of whichever client started it, which may be Emacs with a short
 * PATH. Read once at start, never per call; undefined when the shell does not answer.
 */
async function loginPath(): Promise<string | undefined> {
	try {
		const { stdout } = await promisify(execFile)(
			process.env.SHELL || '/bin/sh',
			['-l', '-c', 'printf "\\n%s" "$PATH"'],
			{ timeout: 10_000 }
		)
		// The last line: a login script may print before it.
		const path = stdout.slice(stdout.lastIndexOf('\n') + 1)
		if (path !== '') return path
	} catch {}
}

/**
 * The provider asks go to: `openai` with Sign in with ChatGPT or `OPENAI_API_KEY`, or the
 * legacy `openai-codex` when only its device code sign-in is stored.
 */
async function chatgpt(models: Models): Promise<'openai' | 'openai-codex'> {
	if ((await models.checkAuth('openai')) !== undefined) return 'openai'
	return (await models.checkAuth('openai-codex')) !== undefined ? 'openai-codex' : 'openai'
}

/**
 * Answers a login flow's prompts with nobody to type them. The legacy flow asks for its
 * method only when it is used for its device code. The new flow offers to paste the
 * redirect URL; the callback server answers instead, and the flow then aborts the prompt.
 */
async function answer(prompt: AuthPrompt): Promise<string> {
	if (prompt.type === 'select') return 'device_code'
	const { signal } = prompt
	if (prompt.type === 'manual_code' && signal !== undefined)
		await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
	throw new Error(`cannot answer "${prompt.message}"`)
}

/**
 * Hold an exclusive SQLite lock on `path` for the life of the process; the OS drops it when
 * the process dies, even by `kill -9`. Waits a little for a daemon that is shutting down,
 * then returns undefined while another one holds it.
 */
function lock(path: string): (() => void) | undefined {
	const db = new DatabaseSync(path, { timeout: 10_000 })
	try {
		db.exec('PRAGMA journal_mode = MEMORY; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE')
	} catch (error) {
		db.close()
		if ((error as { errcode?: number }).errcode === 5) return undefined // SQLITE_BUSY
		throw error
	}
	return () => db.close()
}

/** This shell's record, created with a fresh id on first run. */
async function shellRecord(path: string): Promise<ShellRecord> {
	const saved = await readJson<ShellRecord>(path)
	if (saved !== undefined) return saved
	const record: ShellRecord = {
		id: randomUUID(),
		name: hostname(),
		kind: process.platform === 'darwin' ? 'mac' : process.platform
	}
	await writeFile(path, `${JSON.stringify(record, null, '\t')}\n`, { flag: 'wx' })
	return record
}

/** The JSON in the file at `path`, or undefined when there is none. */
async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, 'utf8'))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
}
