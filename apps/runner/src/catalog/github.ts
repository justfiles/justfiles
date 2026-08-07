/**
 * The GitHub client. Everything that talks upstream goes through here, so the
 * one rule that matters is stated once: **authenticate every call**, public
 * repository or not. Unauthenticated GitHub is 60 requests/hour *per IP*, and a
 * Worker's egress IP is shared with strangers. The same reasoning is why nothing
 * here reads `raw.githubusercontent.com`, which cannot be authenticated for a
 * public repo and is limited per IP too.
 */

const API = 'https://api.github.com'
const UA = 'justapps-runner (+https://justapps.run)'

const auth = (env: CloudflareBindings) => ({
	authorization: `Bearer ${env.GITHUB_TOKEN}`,
	'user-agent': UA
})

/** A REST GET, conditional when given an ETag. */
export const api = (env: CloudflareBindings, path: string, etag?: string | null) =>
	fetch(`${API}${path}`, {
		headers: {
			accept: 'application/vnd.github+json',
			...auth(env),
			...(etag ? { 'if-none-match': etag } : {})
		}
	})

/**
 * A GraphQL query. It supports no conditional requests, so it is only for reads
 * that something else has already established are necessary — one costs its
 * points every time, where a REST 304 costs none.
 */
export async function graphql<T>(
	env: CloudflareBindings,
	query: string,
	variables: Record<string, string>
): Promise<T> {
	const res = await fetch(`${API}/graphql`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...auth(env) },
		body: JSON.stringify({ query, variables })
	})
	if (!res.ok) throw new Error(`graphql: ${res.status}`)

	// GraphQL reports query failures as HTTP 200 with an `errors` array, so a bare
	// `res.ok` check passes straight through them.
	const body = await res.json<{ data?: T; errors?: { message: string }[] }>()
	if (body.errors?.length) throw new Error(`graphql: ${body.errors[0]?.message}`)
	if (!body.data) throw new Error('graphql: no data')
	return body.data
}
