import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** `settings.json` in the shell directory. Every key is optional; there may be no file at all. */
export interface Settings {
	/** A model id on the provider in use; every one is on `openai`. */
	model?: string
	/** `false` in every shell but one on the same Volume: one shell consolidates the notes. */
	consolidate?: boolean
	/** An IANA time zone for the day of the notes and the time in the prompt; the machine's by default. */
	timeZone?: string
	/** The hour a new day, and with it a new session, starts at; 4 by default, `false` for never. */
	dayBoundary?: number | false
	/** The Volume's root on disk; `~` is the home directory. Default `~/files`. */
	root?: string
}

/** The settings of the shell in `dir`; none when it has no `settings.json`. */
export function readSettings(dir: string): Settings {
	try {
		return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		return {}
	}
}

/** The Volume's root on disk, as an absolute path. */
export function volumeRoot({ root = '~/files' }: Settings): string {
	return resolve(homedir(), root.replace(/^~(?=\/|$)/, homedir()))
}
