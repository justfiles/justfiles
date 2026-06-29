import {
	type Assistant,
	createAgent,
	createAssistant,
	createJustBashTool,
	text
} from '@justfiles/agent'
import { RpcTarget } from 'capnweb'
import { resolveAgentBackend } from '../quayd/chatgpt'
import { getVolume } from './fs'

class AgentImpl extends RpcTarget {
	constructor(private agent: Assistant) {
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

export async function agentRpcTarget() {
	const fs = await getVolume()
	const llm = await resolveAgentBackend(fs)
	if (!llm) throw new Error('failed to get llm config')

	const rt = await createAssistant({
		volume: fs,
		agent: createAgent(llm),
		text: text(llm),
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000
		}
	})

	const bash = createJustBashTool({
		volume: fs
	})

	rt.addTools([bash])

	return new AgentImpl(rt)
}
