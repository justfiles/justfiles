import { createModels, createProvider, type Model, type Models } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { type AgentBackend, modelsBackend, text } from '@justfiles/agent'
import type { AiAccountLease } from '@justfiles/app/capabilities/accounts/host'
import type { Provider } from '@justfiles/app/capabilities/accounts/providers'

const ID = 'kodama'

type ModelDescriptor = Omit<Model<'openai-completions'>, 'api' | 'provider' | 'baseUrl'>

export function createKodamaAi(deps: { origin: string; getToken: () => Promise<string | null> }) {
	const baseUrl = new URL('/api/ai/v1', deps.origin).toString().replace(/\/$/, '')
	const models = createModels()
	models.setProvider(
		createProvider({
			id: ID,
			name: 'Kodama',
			baseUrl,
			auth: {
				apiKey: {
					name: 'Kodama',
					resolve: async () => {
						const token = await deps.getToken()
						return token ? { auth: { apiKey: token }, source: 'Kodama' } : undefined
					}
				}
			},
			models: [],
			fetchModels: async ({ credential, signal }) => {
				const token = credential?.type === 'api_key' ? credential.key : undefined
				if (!token) return []
				const response = await fetch(new URL('/api/ai/model', deps.origin), {
					headers: { authorization: `Bearer ${token}` },
					signal
				})
				if (!response.ok) throw await responseError(response)
				const model = (await response.json()) as ModelDescriptor
				return [{ ...model, api: 'openai-completions', provider: ID, baseUrl }]
			},
			api: openAICompletionsApi()
		})
	)

	const getBackend = () => kodamaBackend(models)
	const provider: Provider = {
		id: ID,
		name: 'Kodama',
		builtin: true,
		auth: {
			ui: { kind: 'none' },
			acquire: async () => ({ accountId: ID, creds: {} })
		},
		capabilities: {
			ai: {
				bind: () => ({
					generateText: async ({ system, prompt }) => {
						const backend = await getBackend()
						if (!backend) throw new Error('No AI provider is turned on for this Mac')
						return {
							text: await text(backend).gen(typeof system === 'string' ? system : '', prompt)
						}
					}
				})
			}
		}
	}
	return {
		provider,
		backend: ({ providerId }: AiAccountLease) =>
			providerId === ID ? getBackend() : Promise.resolve(null)
	}
}

async function kodamaBackend(models: Models): Promise<AgentBackend | null> {
	const refreshed = await models.refresh()
	const model = models.getModels(ID)[0]
	if (model) return modelsBackend(models, model)
	const failure = refreshed.errors.get(ID)
	if (failure) throw failure
	return null
}

async function responseError(response: Response): Promise<Error> {
	const body = await response.text().catch(() => '')
	return new Error(`Kodama AI request failed (${response.status})${body ? `: ${body}` : ''}`)
}
