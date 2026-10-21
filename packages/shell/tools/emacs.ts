import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from '@justfiles/ghost'

/** Emacs answers at once unless it is waiting on the user, for a minibuffer prompt say. */
const TIMEOUT_MS = 30_000

/** `emacsclient --eval` in the user's running Emacs; `root` is the Volume's root on disk. */
export function emacsTool(root: string): Tool<{ expression: string }> {
	return {
		name: 'emacs',
		description: `Evaluate an Emacs Lisp expression in the user's running Emacs on this device with \`emacsclient --eval\`, and return the value Emacs prints. An error signalled in Emacs, or no Emacs server, comes back as an error with Emacs's message. Emacs sees real paths: the Volume path \`/x\` is \`${root}/x\` there. Use it to act in the user's editor, for example \`(find-file "${root}/notes/a.md")\`, to ask what they have open, or to run their own commands.`,
		parameters: {
			type: 'object',
			properties: {
				expression: { type: 'string', description: 'Emacs Lisp expression to evaluate' }
			},
			required: ['expression']
		},
		async execute({ expression }, { signal }) {
			try {
				const { stdout } = await promisify(execFile)('emacsclient', ['--eval', expression], {
					signal,
					timeout: TIMEOUT_MS
				})
				return { text: stdout.replace(/\n$/, '') }
			} catch (error) {
				if (signal.aborted) throw error
				const { stderr, killed, message } = error as {
					stderr?: string
					killed?: boolean
					message: string
				}
				if (killed)
					return { text: `Emacs did not answer in ${TIMEOUT_MS / 1000} seconds`, isError: true }
				return { text: stderr?.trim() || message, isError: true }
			}
		}
	}
}
