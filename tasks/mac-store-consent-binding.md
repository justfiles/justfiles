---
project: apps/mac
status: todo
---

# mac: bind each App Store consent sheet to its own offer

`daemon/store.ts` keeps the releases its last `GET /store` resolved and installs one of those
entries rather than re-resolving the registry — so a pointer that moves after a row renders
cannot slip a different release past the consent sheet.

The cache is one map for the whole daemon, though, replaced by every listing. So: launcher A
renders release R, the publisher replaces it in place with same-version R′, launcher B (or the
same launcher reopened, or an app page — see `mac-daemon-loopback-auth.md`) calls `GET /store`,
and A's confirm now installs R′ under a version check that still passes.

The fix is per-listing offers instead of a shared latest: `GET /store` mints an opaque handle
per row and retains the object behind it, `POST /store/<id>` carries that handle instead of
`version`, and handles expire (bounded retention, so the map cannot grow without limit). Worth
doing with the rest of the App Store consent story rather than alone — the same-origin app-page
hole is the wider one.
