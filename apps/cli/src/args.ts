import { parseArgs } from 'node:util'
import { CliUsageError } from './errors.ts'

type ParsedCommandArgs = {
	values: Record<string, string | boolean | undefined>
	positionals: string[]
}

export function parseCommandArgs(
	config: Parameters<typeof parseArgs>[0],
	help: string
): ParsedCommandArgs {
	try {
		return parseArgs({ ...config, strict: true }) as ParsedCommandArgs
	} catch (error) {
		throw new CliUsageError(error instanceof Error ? error.message : String(error), help)
	}
}
