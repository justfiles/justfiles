import type { Api, Model } from '@mariozechner/pi-ai'

export type LLMConfig = {
	model: Model<Api>
	apiKey: string
}
