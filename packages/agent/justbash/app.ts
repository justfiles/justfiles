import type { AppController } from '../bash/commands/app.ts'
import type { ShellCommand } from './index.ts'

// The agent↔kernel bridge is unchanged — only the command wrapper is reshaped:
// the existing `run(controller, argv)` dispatch logic is reusable verbatim, it
// just returns an ExecResult ({ stdout, stderr, exitCode }) to just-bash now
// instead of our old CommandResult (same fields).
export type { AppController }

/**
 * The `app` command as a ShellCommand: list, launch, inspect, and drive apps over
 * the kernel (see apps/quay/quayd/agent.ts). The canonical example of a custom
 * command — it ignores the fs entirely and closes over an injected controller,
 * showing that a ShellCommand is just a named `execute` with a summary.
 */
export function createAppCommand(controller: AppController): ShellCommand {
	void controller
	throw new Error('createAppCommand: not implemented')
}
