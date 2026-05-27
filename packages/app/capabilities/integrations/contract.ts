// App-facing Integrations capability. Lets a Settings-style app browse the
// host's registered integrations and connect or disconnect accounts. The
// host owns provider definitions and credential storage; this contract is
// the smallest surface a UI needs.

export interface IntegrationField {
	type: 'string'
	minLength?: number
	description?: string
}

export interface IntegrationCredentialsSchema {
	type: 'object'
	properties: Record<string, IntegrationField>
	required?: string[]
}

export interface IntegrationDescriptor {
	id: string
	name: string
	description: string
	credentialsSchema: IntegrationCredentialsSchema
	connectedAccounts: ReadonlyArray<{ accountId: string; lastError?: string }>
}

export interface IntegrationsCapability {
	list(input: Record<string, never>): Promise<IntegrationDescriptor[]>
	connect(input: {
		id: string
		accountId: string
		credentials: Record<string, string>
	}): Promise<void>
	disconnect(input: { id: string; accountId: string }): Promise<void>
}
