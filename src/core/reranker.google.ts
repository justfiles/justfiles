import type { Reranker, RerankCandidate, RerankResult } from './reranker'

type GoogleCredentials = {
	client_email: string
	private_key: string
}

type TokenCache = {
	token: string
	expiresAt: number
}

function base64url(data: ArrayBuffer | string): string {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
	let str = ''
	for (const byte of bytes) str += String.fromCharCode(byte)
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function createJwt(credentials: GoogleCredentials): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
	const payload = base64url(
		JSON.stringify({
			iss: credentials.client_email,
			scope: 'https://www.googleapis.com/auth/cloud-platform',
			aud: 'https://oauth2.googleapis.com/token',
			iat: now,
			exp: now + 3600
		})
	)

	const signingInput = `${header}.${payload}`

	const pem = credentials.private_key.replace(
		/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g,
		''
	)
	const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))

	const cryptoKey = await crypto.subtle.importKey(
		'pkcs8',
		der,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	)

	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		cryptoKey,
		new TextEncoder().encode(signingInput)
	)

	return `${signingInput}.${base64url(signature)}`
}

async function fetchAccessToken(credentials: GoogleCredentials): Promise<TokenCache> {
	const jwt = await createJwt(credentials)

	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: jwt
		})
	})

	if (!response.ok) throw new Error(`Google auth failed (${response.status})`)

	const data = (await response.json()) as { access_token: string; expires_in: number }
	return {
		token: data.access_token,
		expiresAt: Date.now() + (data.expires_in - 60) * 1000
	}
}

export function googleReranker(
	projectId: string,
	credentials: GoogleCredentials,
	model = 'semantic-ranker-default@latest'
): Reranker {
	let tokenCache: TokenCache | null = null

	async function getToken(): Promise<string> {
		if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token
		tokenCache = await fetchAccessToken(credentials)
		return tokenCache.token
	}

	return {
		provider: 'google',
		model,

		async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankResult[]> {
			console.log(`!! reranking is happening !!`)
			if (candidates.length === 0) return []

			const token = await getToken()
			const url = `https://discoveryengine.googleapis.com/v1/projects/${projectId}/locations/global/rankingConfigs/default_ranking_config:rank`

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'X-Goog-User-Project': projectId
				},
				body: JSON.stringify({
					model,
					query,
					records: candidates.map((c) => ({ id: c.id, content: c.text })),
					ignoreRecordDetailsInResponse: true
				})
			})

			if (!response.ok) throw new Error(`Google reranker failed (${response.status})`)

			const data = (await response.json()) as {
				records: Array<{ id: string; score: number }>
			}
			const result = data.records.map((r) => ({ id: r.id, score: r.score }))
			console.log({ query, candidates, result })
			return result
		}
	}
}
