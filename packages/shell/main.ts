import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createModels } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { openGhost, type ShellRecord } from '@justfiles/ghost'
import { openNodeSqliteState } from '@justfiles/ghost/state/node-sqlite'
import { serve } from './daemon.ts'
import { filesRoot, shellDir, socketPath } from './paths.ts'

/** Run the daemon until it goes idle. Returns at once when another daemon holds the lock. */
export async function main(): Promise<void> {
	const dir = shellDir()
	await mkdir(dir, { recursive: true, mode: 0o700 })
	const release = lock(join(dir, 'lock'))
	if (release === undefined) return
	try {
		// For now the provider reads OPENAI_API_KEY; Sign in with ChatGPT replaces it.
		const models = createModels()
		models.setProvider(openaiProvider())
		const ghost = await openGhost({
			volume: volume(fsStore(filesRoot(), { mounts: ['private'] })),
			state: await openNodeSqliteState(join(dir, 'state.sqlite')),
			models,
			shell: await shellRecord(join(dir, 'shell.json')),
			settings: { model: { provider: 'openai', modelId: 'gpt-5.5' } }
		})
		const stop = new AbortController()
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort())
		await serve(ghost, socketPath(dir), { signal: stop.signal })
	} finally {
		release()
	}
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
	try {
		return JSON.parse(await readFile(path, 'utf8'))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	const record: ShellRecord = {
		id: randomUUID(),
		name: hostname(),
		kind: process.platform === 'darwin' ? 'mac' : process.platform
	}
	await writeFile(path, `${JSON.stringify(record, null, '\t')}\n`, { flag: 'wx' })
	return record
}
