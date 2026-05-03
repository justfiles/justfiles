import { FileType } from '@justfiles/fs/types'
import { defineCommand } from '../define.ts'

function errorMessage(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : String(error)
	return message || fallback
}

export const cp = defineCommand({
	name: 'cp',
	summary: 'Copy a file',
	args: [
		{ name: 'src', required: true, description: 'Source path' },
		{ name: 'dst', required: true, description: 'Destination path' }
	],
	flags: [{ name: 'force', short: 'f', description: 'Overwrite destination if it exists' }],
	async run({ args, flags }, { vol }) {
		if (!(await vol.exists(args.src))) {
			return { stdout: '', stderr: `cp: ${args.src}: no such file`, exitCode: 1 }
		}
		if (!flags.force && (await vol.exists(args.dst))) {
			return {
				stdout: '',
				stderr: `cp: ${args.dst}: destination exists (use --force to overwrite)`,
				exitCode: 1
			}
		}
		try {
			await vol.cp(args.src, args.dst)
			return { stdout: '', stderr: '', exitCode: 0 }
		} catch (error) {
			return { stdout: '', stderr: `cp: ${errorMessage(error, 'copy failed')}`, exitCode: 1 }
		}
	}
})

export const mv = defineCommand({
	name: 'mv',
	summary: 'Move or rename a file',
	args: [
		{ name: 'src', required: true, description: 'Source path' },
		{ name: 'dst', required: true, description: 'Destination path' }
	],
	async run({ args }, { vol }) {
		if (!(await vol.exists(args.src))) {
			return { stdout: '', stderr: `mv: ${args.src}: no such file`, exitCode: 1 }
		}
		try {
			await vol.rename(args.src, args.dst)
			return { stdout: '', stderr: '', exitCode: 0 }
		} catch (error) {
			return { stdout: '', stderr: `mv: ${errorMessage(error, 'move failed')}`, exitCode: 1 }
		}
	}
})

export const rm = defineCommand({
	name: 'rm',
	summary: 'Remove a file or directory',
	args: [{ name: 'path', required: true, description: 'Path to remove' }],
	flags: [
		{ name: 'recursive', short: 'r', description: 'Remove directories and their contents' },
		{ name: 'force', short: 'f', description: 'Ignore missing paths' }
	],
	async run({ args, flags }, { vol }) {
		if (!flags.recursive) {
			try {
				const stat = await vol.stat(args.path)
				if (stat.type === FileType.Directory) {
					return {
						stdout: '',
						stderr: `rm: ${args.path}: is a directory (use -r to remove)`,
						exitCode: 1
					}
				}
			} catch (error) {
				if (!flags.force) {
					return { stdout: '', stderr: `rm: ${errorMessage(error, args.path)}`, exitCode: 1 }
				}
				return { stdout: '', stderr: '', exitCode: 0 }
			}
		}
		try {
			await vol.rm(args.path, { recursive: flags.recursive, force: flags.force })
			return { stdout: '', stderr: '', exitCode: 0 }
		} catch (error) {
			return { stdout: '', stderr: `rm: ${errorMessage(error, 'remove failed')}`, exitCode: 1 }
		}
	}
})
