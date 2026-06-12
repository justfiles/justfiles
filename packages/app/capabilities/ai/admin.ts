import { defineCapability } from '../core.ts'
import type { AiAdminCapability } from './contract.ts'

export type { AgentModelOption, AgentStatus, AiAdminCapability } from './contract.ts'

// The admin facet of the `ai` capability — the SETUP side. Same id as the use
// facet (`ai`): the kernel routes by id, so a host registers one `ai` unit and
// serves whichever facet it implements. Apps declare this with the conventional
// `admin` scope, but the scope string alone grants nothing — the host gates the
// facet on first-party app identity (see quayd's `aiAdmin.ts`), mirroring the
// volume capability's `system` scope. Only the Settings app binds it.
export const aiAdmin = defineCapability<'ai', AiAdminCapability>('ai')
