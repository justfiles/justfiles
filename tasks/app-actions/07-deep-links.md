---
status: later
depends_on: T2, T4
milestone: none
---

# T7: Add deep-link entry points

## Result

Native Just Computer hosts can receive stable links that open an app or prepare
an action, while all actual mutations continue through the authenticated action
gateway.

This is optional. The browser extension, CLI, and MCP do not depend on it.

## Boundary

Deep links are good for navigation and handoff, but poor bearer APIs: browsers,
chat apps, histories, analytics, and OS launch services routinely expose URLs.
Therefore:

- `justcomputer://apps/<appId>` may launch/focus an app;
- an action link may populate a confirmation screen; and
- a deep-link or HTTP `GET` must never silently run a mutating action.

After the user confirms, the trusted native host sends an authenticated `POST`
to the same `/api/v1/apps/<appId>/actions/<action>` route or calls the equivalent
local controller when it is already the account host.

## Work

1. Define one versioned, URL-encoded link grammar for navigation and prepared
   actions.
2. Register it in the macOS host and route it through one parser.
3. Validate scheme, host, path segment decoding, maximum length, and allowed
   JSON payload before displaying confirmation.
4. Resolve app/action names through live inspection; do not keep a second
   registry.
5. Show the target app, action, and meaningful parameters before a mutation.
6. Add Universal Links/App Links only if a concrete web-to-native handoff needs
   them.

## Tests

- malformed, oversized, double-encoded, and unknown app/action links;
- navigation links launch without running an action;
- action links cannot run before explicit confirmation;
- secrets in query parameters are rejected; and
- the confirmed execution reaches the same app action as the HTTP adapter.

## References

- [Apple App Intents](https://developer.apple.com/documentation/appintents)
- [Raycast deeplinks](https://developers.raycast.com/information/lifecycle/deeplinks)

## Non-goals

- Putting session tokens or API keys in a URL.
- Treating custom URL schemes as a cross-device API.
- Shipping this before a real workflow needs it.
