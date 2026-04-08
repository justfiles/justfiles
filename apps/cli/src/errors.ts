export class CliUsageError extends Error {
	readonly help?: string

	constructor(message: string, help?: string) {
		super(message)
		this.name = 'CliUsageError'
		this.help = help
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function getErrno(error: unknown): string | null {
	const message = errorMessage(error)
	const match = /^([A-Z0-9]+):/.exec(message)
	return match?.[1] ?? null
}

export function exitCodeForError(error: unknown): number {
	if (error instanceof CliUsageError) return 4

	switch (getErrno(error)) {
		case 'ENOENT':
			return 2
		case 'EEXIST':
		case 'ENOTEMPTY':
			return 3
		case 'EINVAL':
			return 4
		default:
			return 1
	}
}
