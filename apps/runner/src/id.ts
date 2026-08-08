/**
 * An app id is dotted — `justfiles.draw`, or `com.alice.draw` once a domain can
 * prove a namespace — but every app needs its own origin, and a wildcard
 * certificate matches exactly one label. So the id is inlined into a single DNS
 * label using IPFS's DNSLink encoding, which exists for the same reason:
 * https://specs.ipfs.tech/http-gateways/subdomain-gateway/
 *
 *     every `-` becomes `--`, then every `.` becomes `-`
 *
 * Escaping the hyphen rather than the dot keeps the common case clean —
 * `justfiles.draw` is `justfiles-draw` — while staying injective for the names
 * that do carry hyphens, which GitHub logins and IDN (`xn--…`) domains both do.
 */

/**
 * One id segment. It never starts or ends with `-`, which is what keeps hyphen
 * runs unambiguous: a run of one is a dot, a run of 2n is n hyphens. Were `-.`
 * or `.-` legal, `a-.b` and `a.-b` would both encode to `a---b`.
 */
const SEGMENT = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'

/** Publisher and app at least; a reversed domain prepends further segments. */
const ID = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})+$`)

/** The longest DNS label, and so the longest encodable id. */
const MAX_LABEL = 63

export const encodeLabel = (id: string): string => id.replaceAll('-', '--').replaceAll('.', '-')

/**
 * The id a label encodes, or null when the label is not the one canonical
 * encoding of a well-formed id. Re-encoding is the test: it rejects every
 * non-canonical form without enumerating them, which matters because the label
 * arrives in a Host header — two labels reaching one app would be two origins
 * over a single store. Hostnames are case-insensitive, so callers lowercase.
 */
export const decodeLabel = (label: string): string | null => {
	if (label.length > MAX_LABEL) return null
	const id = label.replaceAll(/-+/g, (run) =>
		run.length === 1 ? '.' : '-'.repeat(run.length >> 1)
	)
	return ID.test(id) && encodeLabel(id) === label ? id : null
}
