import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Volume } from '@justfiles/fs'
import { Bash, type Command, type CommandName, type ExecResult, getCommandNames } from 'just-bash'
import Type from 'typebox'
import { SECRET_PREFIXES } from '../paths.ts'
import { truncateTail } from './truncate.ts'
import { volumeFs } from './volume-fs.ts'

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
export function createJustBashTool(options: JustBashToolOptions): AgentTool<typeof bashParams> & {
	ready: Promise<void>
	dispose(): Promise<void>
} {
	const { volume, commands = [], disable, cwd = '/', env } = options
	// `disable` is a deny-list over the built-ins; just-bash takes an allow-list,
	// so we hand it every built-in minus the disabled names. Omitting it entirely
	// (no deny-list) keeps all built-ins, which is the just-bash default.
	const allow = disable?.length
		? (getCommandNames().filter((name) => !disable.includes(name)) as CommandName[])
		: undefined
	// One Bash per tool, reused across calls: the volume (and thus cwd, env, and
	// any files written) persists between turns. Custom commands override built-ins
	// of the same name; a ShellCommand is structurally a just-bash Command.
	//
	// The credential trees are denied at the fs seam, not asked for in the prompt: the
	// agent reads untrusted text (fetch/search), so a prompt instruction is not a boundary.
	// There is exactly ONE policy, so it is imported rather than made an option.
	const fs = volumeFs(volume, SECRET_PREFIXES)
	const startup = fs.ready.then(
		() =>
			new Bash({
				fs,
				cwd,
				env,
				commands: allow,
				customCommands: commands
			})
	)
	const ready = startup.then(() => {})
	void ready.catch(() => {})
	const description = describe(commands)
	return {
		ready,
		dispose: fs.dispose,
		name: 'bash',
		label: 'Bash',
		description,
		parameters: bashParams,
		async execute(_toolCallId, params, signal) {
			return formatResult(await run(await startup, params.command, signal))
		}
	}
}

async function run(bash: Bash, command: string, signal?: AbortSignal): Promise<ExecResult> {
	try {
		return await bash.exec(command, { signal })
	} catch (error) {
		// A non-zero exit is normal output; only an unexpected throw lands here.
		return {
			stdout: '',
			stderr: error instanceof Error ? error.message : String(error),
			exitCode: 1
		}
	}
}

function describe(commands: ShellCommand[]): string {
	const intro =
		'Run a command line in a real in-process bash shell over your filesystem: pipes, redirects, globs, variables, and control flow all work, alongside the standard unix commands (cat, ls, grep, sed, awk, find, jq, sort, …). Use "<command> --help" for usage.'
	if (commands.length === 0) return intro
	const lines = commands.map((c) => `- ${c.name}: ${c.summary}`).join('\n')
	return `${intro}\n\nAlso available:\n${lines}`
}

function formatResult(result: ExecResult) {
	const parts: string[] = []
	if (result.stdout) parts.push(result.stdout)
	if (result.stderr) parts.push(result.stderr)
	const merged = parts.join(parts.length > 1 ? '\n' : '') || '(no output)'
	const truncated = truncateTail(merged)
	const text =
		result.exitCode === 0 ? truncated.text : `${truncated.text}\n[exit code ${result.exitCode}]`
	return {
		content: [{ type: 'text' as const, text }],
		details: {
			exitCode: result.exitCode,
			truncated: truncated.truncated,
			droppedBytes: truncated.droppedBytes
		}
	}
}
