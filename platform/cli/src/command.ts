import type { Volume } from '@justfiles/fs'

export interface CommandContext {
	volume: Volume
	volumeName: string
	json: boolean
	quiet: boolean
}

export interface CommandModule {
	help: string
	run(args: string[], context: CommandContext): Promise<void>
}
