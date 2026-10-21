import { execFile } from 'node:child_process'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import type { Tool } from '@justfiles/ghost'
import { devicePath } from '../paths.ts'

/** A scheme, as in `https:` or `mailto:`, is a URL; anything else is a Volume path. */
const URL = /^[a-z][a-z\d+.-]*:/i

/** Hands a file or URL to the OS, as a double click does; `root` is the Volume's root on disk. */
export function openTool(root: string): Tool<{ target: string }> {
	return {
		name: 'open',
		description: `Open a file or a URL on this device in its default app, as a double click would: a Volume path such as \`/notes/a.pdf\` (relative paths start from the directory the user asked from), or a URL such as \`https://…\` or \`mailto:…\`.`,
		parameters: {
			type: 'object',
			properties: {
				target: { type: 'string', description: 'Volume path or URL' }
			},
			required: ['target']
		},
		async execute({ target }, { signal, cwd }) {
			const opened = URL.test(target) ? target : devicePath(posix.resolve(cwd, target), root)
			const program = process.platform === 'darwin' ? 'open' : 'xdg-open'
			try {
				await promisify(execFile)(program, [opened], { signal, timeout: 10_000 })
				return { text: `opened ${opened}` }
			} catch (error) {
				if (signal.aborted) throw error
				const { stderr, message } = error as { stderr?: string; message: string }
				return { text: stderr?.trim() || message, isError: true }
			}
		}
	}
}
