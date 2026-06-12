import { defineCapability } from '../core.ts'
import type { AgentSetupCapability } from './contract.ts'

export type { AgentModelOption, AgentSetupCapability, AgentStatus } from './contract.ts'

export const agentSetup = defineCapability<'agentSetup', AgentSetupCapability>('agentSetup')
