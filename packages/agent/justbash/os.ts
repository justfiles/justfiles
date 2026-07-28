import type { ExecResult } from 'just-bash'
import type { ShellCommand } from './index.ts'

/**
 * The `os` command — a read-only projection of the host's shell.
 *
 * `/system/os-state.json` is a persistence artifact (versioned, normalised in host code,
 * free to change), so the agent must never parse it. The host projects the one fact the
 * agent can act on — what the user is looking at — into this port, and the command renders
 * it as plain text that pipes like any other shell output.
 */
export interface OsWindowInfo {
	appId?: string // absent for a non-app window (e.g. the chat window)
	title?: string
	focused: boolean
	minimized?: boolean
}

export type OsState = () => Promise<{ windows: readonly OsWindowInfo[] }>

export function createOsCommand(read: OsState): ShellCommand {
	return {
		name: 'os',
		summary:
			"Read the user's shell. `os windows` lists the open windows and marks the focused one — use it to know what the user is looking at.",
		execute: (argv) => run(read, argv)
	}
}

const HELP = 'usage: os windows'

async function run(read: OsState, argv: string[]): Promise<ExecResult> {
	const [cmd = 'help'] = argv
	if (cmd === 'help' || cmd === '--help' || cmd === '-h') return out(HELP)
	if (cmd !== 'windows') return fail(`os: unknown subcommand '${cmd}'\n${HELP}`)
	const { windows } = await read()
	if (windows.length === 0) return out('no windows open')
	const width = Math.max(...windows.map((w) => (w.appId ?? '-').length))
	return out(windows.map((w) => line(w, width)).join('\n'))
}

function line(w: OsWindowInfo, width: number): string {
	const parts = [w.focused ? '*' : ' ', (w.appId ?? '-').padEnd(width), w.title ?? '']
	if (w.minimized) parts.push('(minimized)')
	return parts.join(' ').trimEnd()
}

// Plain text on stdout / stderr with an exit code — the shell-native signals, same as `app`.
const out = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string): ExecResult => ({ stdout: '', stderr, exitCode: 1 })
