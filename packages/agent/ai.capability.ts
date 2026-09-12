import {
	type GenerateText,
	aiCapability as hostCapability
} from '@justfiles/app/capabilities/ai/host'
import type { Volume } from '@justfiles/fs'
import { learningContext } from './learning-context.ts'

export type { GenerateText } from '@justfiles/app/capabilities/ai/host'

export function aiCapability(deps: {
	generate: GenerateText
	volume?: Volume
	agent?: Parameters<typeof hostCapability>[0]['agent']
}) {
	const { generate, volume } = deps
	return hostCapability({
		...deps,
		learning: volume
			? learningContext({ volume, gen: (system, prompt) => generate({ system, prompt }) }).compose
			: undefined
	})
}
