import { getSessionToken } from './auth.ts'

export interface AppSummary {
	id: string
	name: string
	description?: string
}

export interface AppInspection extends AppSummary {
	state: unknown
	actions: Record<string, unknown>
}

export type AppActionsErrorCode =
	| 'signed_out'
	| 'invalid_request'
	| 'invalid_params'
	| 'unauthorized'
	| 'app_not_installed'
	| 'action_not_found'
	| 'action_failed'

export class AppActionsError extends Error {
	readonly code: AppActionsErrorCode

	constructor(code: AppActionsErrorCode, message: string) {
		super(message)
		this.code = code
	}
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
	const token = await getSessionToken()
	if (!token) throw new AppActionsError('signed_out', 'Sign in to Just Computer')

	let response: Response
	try {
		response = await fetch(`${new URL(import.meta.env.WXT_FRIEREN_API_ORIGIN).origin}${path}`, {
			...init,
			headers: {
				...init?.headers,
				authorization: `Bearer ${token}`
			}
		})
	} catch {
		throw new AppActionsError('action_failed', 'Could not reach Just Computer')
	}

	const body = await response.json().catch(() => null)
	if (!response.ok) throw responseError(response.status, body)
	return body
}

export async function list(): Promise<AppSummary[]> {
	return (await request('/api/v1/apps')) as AppSummary[]
}

export async function inspect(appId: string): Promise<AppInspection> {
	return (await request(`/api/v1/apps/${encodeURIComponent(appId)}`)) as AppInspection
}

export async function run(appId: string, action: string, params: unknown): Promise<unknown> {
	const body = (await request(
		`/api/v1/apps/${encodeURIComponent(appId)}/actions/${encodeURIComponent(action)}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(params)
		}
	)) as { result?: unknown }
	return body?.result
}

function responseError(status: number, body: unknown): AppActionsError {
	const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
	const code = errorCode(error?.code) ?? (status === 401 ? 'unauthorized' : 'action_failed')
	const message = typeof error?.message === 'string' ? error.message : 'Action failed'
	return new AppActionsError(code, message)
}

function errorCode(value: unknown): AppActionsErrorCode | undefined {
	if (
		value === 'invalid_request' ||
		value === 'invalid_params' ||
		value === 'unauthorized' ||
		value === 'app_not_installed' ||
		value === 'action_not_found' ||
		value === 'action_failed'
	)
		return value
}
