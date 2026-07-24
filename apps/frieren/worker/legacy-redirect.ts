// Legacy → new host redirects (Kodama rebrand; temporary, removed once the
// rebrand lands). A request whose host is a key here gets a 307 to its
// replacement, preserving path, query, and hash.
//
// IMPORTANT: this worker's code also ships to production (via release-please), so
// only hosts that are ACTUALLY ready to redirect may appear here. The staging
// pair is live; `spud.computer` is deliberately absent until the prod cutover, so
// deploying this to prod early never redirects real users.
export const LEGACY_HOST_REDIRECTS: Record<string, string> = {
	'staging.spud.computer': 'staging.mykodama.app'
}

// Returns a 307 to the mapped host (path/query/hash preserved) when the request's
// host is a retired one, otherwise undefined so the caller serves normally.
export function legacyHostRedirect(request: Request): Response | undefined {
	const url = new URL(request.url)
	const target = LEGACY_HOST_REDIRECTS[url.hostname]
	if (!target) return undefined
	url.hostname = target
	// 307 (temporary) keeps the method + body; switched to 308 after the
	// observation window per the runbook. path/search/hash ride on the URL.
	return Response.redirect(url.toString(), 307)
}
