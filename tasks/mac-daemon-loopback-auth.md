---
project: apps/mac
status: todo
---

# mac: enforce the runtime token on the daemon's loopback surface

The daemon listens on `127.0.0.1` and every surface is open: `/system` (slash commands),
`/agent` (prompt the agent), `/app/:id/connect` (dispatch into any installed app). The
native shell already carries `?token=…` on every URL it loads (`runtime.json`), but nothing
checks it — see the comment in `native/Sources/shell/Catalog.swift`.

Any page in any browser on this Mac can open a WebSocket to the daemon (WebSockets are not
subject to CORS) and drive it. The App Store's `POST /store/<id>` rejects a cross-origin
caller by `Origin`, which closes the one route that mutates the Volume over HTTP, but that
is a route-local patch, not the fix.

The fix is one gate for the whole surface: require the runtime token on every HTTP route and
socket upgrade, and hand it to the browser surfaces the way the native shell already
receives it. It has to cover the plain web launcher too (opened at `/` by hand in dev), so
it needs a decision on how a hand-typed URL gets a token — a cookie set by a token-bearing
navigation is the obvious candidate.
