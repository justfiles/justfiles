import { createAgent, type Runtime, runtime, text } from '@justfiles/agent'
import { RpcTarget } from 'capnweb'
import { resolveAgentBackend } from '../quayd/chatgpt'
import type { Volume } from '@justfiles/fs'

class AgentImpl extends RpcTarget {
	constructor(private agent: Runtime) {
		super()
	}

	async prompt(message: string) {
		try {
			return await this.agent.prompt(message)
		} catch (err) {
			console.error('[agent] prompt failed:', err)
			throw err
		}
	}
	async history() {
		try {
			return await this.agent.history()
		} catch (err) {
			console.error('[agent] history failed:', err)
			throw err
		}
	}
}

export async function agentRpcTarget(fs: Volume) {
	const llm = await resolveAgentBackend(fs)
	if (!llm) throw new Error('failed to get llm config')

	const rt = await runtime({
		volume: fs,
		agent: createAgent(llm),
		text: text(llm),
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000
		}
	})

	return new AgentImpl(rt)
}
