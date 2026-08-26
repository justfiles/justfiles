---
project: platform/mac
status: todo
---

# mac: authorize the daemon's loopback surface per caller

The daemon listens on `127.0.0.1` and every surface is open: `/system` (slash commands),
`/agent` (prompt the agent), `/app/:id/connect` (dispatch into any installed app),
`POST /store/:id` (install an app). The native shell already carries `?token=…` on every URL
it loads (`runtime.json`), but nothing checks it — see the comment in
`native/Sources/shell/Catalog.swift`.

Two callers get in:

- **Any page in any browser on this Mac.** WebSockets are not subject to CORS, and a bodyless
  `POST` needs no preflight. The store install route now rejects a request whose `Origin` is
  not the daemon's own; nothing else does.
- **Any installed app.** Its publisher-controlled `gui.js` is imported into a daemon-origin
  document (`ui/app/main.ts`), so an app page is *same-origin* with the launcher and the store.
  No header check or shared secret can separate the two: a same-origin page can read the
  launcher's URL, script an iframe of `/launcher/store`, and open every socket itself.

So the fix is not a token on its own — it is an origin boundary. App documents have to be
served from an origin of their own (a distinct host, so the URL shape and the native booter
change too), and only then is a per-surface token worth enforcing. It also has to cover the
plain web launcher, opened at `/` by hand in dev with no token, which needs a decision on how
a hand-typed URL gets one — a cookie set by a token-bearing navigation being the obvious
candidate.
