/**
 * `/private` — the one name this host joins its own store at, on both sides of the wire.
 *
 * The old engine kept this tree off the wire with a path filter; the store model has
 * none, so the name is a MOUNT instead:
 * a `mount` row claims it in the synced store on every replica, and what stands behind
 * it is each host's own local store — the DO's credentials on the server, the app cache
 * on the browser. Nothing under it is in the table a client pulls, and `authority.ts`'s
 * `holdsRows` makes a subtree under it unspellable.
 *
 * The NAME is what both sides must agree on, and the only thing: a mount row's id is
 * derived from `(parent, name)`, so a server that announced `private` and a client that
 * announced `privaet` would each claim a different name and each shadow the other's row.
 * The store IDS behind it are per-host and mean nothing to anyone else.
 */
export const PRIVATE_MOUNT = 'private'
