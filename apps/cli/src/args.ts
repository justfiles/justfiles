import { parseArgs } from 'util'
import { printError } from './output.ts'

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
		printError(error instanceof Error ? error.message : String(error), help)
		process.exit(4)
	}
}
