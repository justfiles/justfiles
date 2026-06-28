import type { Volume } from '@justfiles/fs'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Command } from 'just-bash'
import Type from 'typebox'

/**
 * A command added to the shell on top of just-bash's ~70 built-ins. It IS a
 * just-bash Command (so it composes with pipes, redirects, `exec`, and runs over
 * the same volume-backed fs) plus a one-line `summary`.
 *
 * The summary is the only thing we add: it surfaces in the tool description, so
 * the agent knows the command exists and what it does without first running
 * `<cmd> --help`. just-bash gives custom commands precedence over a built-in of
 * the same name, so registering a ShellCommand named `cat` OVERRIDES the built-in
 * `cat` — overriding and adding are the same operation.
 */
export interface ShellCommand {
	name: string
	summary: string
	execute: Command['execute']
}

export interface JustBashToolOptions {
	/** Backs the shell's filesystem — every path resolves against this volume. */
	volume: Volume
	/** Commands to add or override (a name that collides with a built-in wins), e.g. `app`. */
	commands?: ShellCommand[]
	/** Built-in command names to remove — a deny-list, e.g. ['curl', 'sqlite3', 'python3']. */
	disable?: string[]
	/** Directory each command runs in (default '/'). */
	cwd?: string
	/** Environment variables seeded into the shell. */
	env?: Record<string, string>
}

const bashParams = Type.Object({
	command: Type.String({ description: 'The full command line to run, including arguments.' })
})

/**
 * The `bash` agent tool, backed by just-bash: a real in-process bash environment
 * (pipes, redirects, globs, control flow, ~70 unix commands) whose filesystem IS
 * the shared Volume (see `volumeFs`). Drop-in replacement for `createBashTool` —
 * the hand-rolled registry/parser/define machinery is gone; just-bash owns
 * parsing and dispatch, and a single `Bash` instance is reused across calls so
 * the volume persists between turns.
 *
 * `disable` becomes just-bash's `commands` allow-list (every built-in minus the
 * deny-list); `commands` becomes its `customCommands`; the description lists the
 * custom commands' summaries plus a note that standard unix commands work.
 */
export function createJustBashTool(options: JustBashToolOptions): AgentTool<typeof bashParams> {
	void options
	throw new Error('createJustBashTool: not implemented')
}
