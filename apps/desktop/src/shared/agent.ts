export type AgentMessage = {
	id: string
	role: 'user' | 'assistant'
	content: string
}
