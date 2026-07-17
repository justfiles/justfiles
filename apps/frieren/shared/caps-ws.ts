// The `_caps` WebSocket authenticates on the handshake, not the URL. Browsers
// can't set an Authorization header on a WS upgrade, and a `?token=` query string
// leaks into proxy/access logs and browser history — so the Clerk token rides a
// `bearer.<token>` WebSocket subprotocol instead. The server reads it off
// `Sec-WebSocket-Protocol` and echoes CAPS_WS_SUBPROTOCOL (the marker, never the
// token) back on the 101, so strict clients — e.g. the `ws`-based dev bridge,
// which rejects a handshake when it offered a subprotocol and the server selected
// none — accept the negotiated connection.
export const CAPS_WS_SUBPROTOCOL = 'justfiles.caps.v1'
const BEARER_PREFIX = 'bearer.'

// Client: the subprotocols the browser offers when opening the caps socket — the
// marker (which the server echoes) plus the bearer-token carrier.
export const capsWsProtocols = (token: string): [string, string] => [
	CAPS_WS_SUBPROTOCOL,
	`${BEARER_PREFIX}${token}`
]

// Server: pull the bearer token out of a `Sec-WebSocket-Protocol` header value.
export const bearerFromProtocolHeader = (header: string | null): string | null => {
	const bearer = header
		?.split(',')
		.map((p) => p.trim())
		.find((p) => p.startsWith(BEARER_PREFIX))
	return bearer ? bearer.slice(BEARER_PREFIX.length) : null
}
