import { defineCapability } from '../core.ts'
import type { IntegrationsCapability } from './contract.ts'

export type {
	IntegrationCredentialsSchema,
	IntegrationDescriptor,
	IntegrationField,
	IntegrationsCapability
} from './contract.ts'

export const integrations = defineCapability<'integrations', IntegrationsCapability>('integrations')
