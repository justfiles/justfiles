---
status: done
depends_on: design
milestone: 1
---

# T1: Prepare Clerk extension authentication

## Result

The Just Computer Chrome extension has a stable extension ID, is trusted by the
existing Clerk instance, can reuse the user's Just Computer web session, and
can obtain a fresh session token in its background service worker.

This task creates the installable extension shell and its authentication. It
does not need the action gateway and may be implemented in parallel with T2.

## Decision

Use Clerk's Chrome Extension SDK and Sync Host:

- the sign-in button opens the existing Just Computer web sign-in in a normal
  tab, so the full Clerk flow remains available;
- Sync Host shares that signed-in state with the extension;
- the Manifest V3 background worker calls
  `createClerkClient({ publishableKey, syncHost, background: true })` and
  `clerk.session.getToken()` immediately before an API request; and
- the extension never contains a Clerk secret key or a user API key.

Do not implement OAuth redirects inside the popup. Clerk documents that OAuth
redirects are not supported by Chrome extension popups, while Sync Host is
designed to bridge an existing web sign-in.

## Work

1. Create `platform/browser-extension`, package
   `@justfiles/browser-extension`, as a minimal WXT package. Use plain
   TypeScript and DOM. Add its package scripts, `wxt.config.ts`, shared
   TypeScript config, and a development README with build/load instructions.
   Milestone 1 targets Chrome MV3, but the source must use WXT entrypoints and
   `wxt/browser` instead of direct Chrome globals.
   Include `dev`, `build`, `build:firefox`, and `postinstall` scripts using
   `wxt`, `wxt build`, `wxt build -b firefox`, and `wxt prepare` respectively.
2. Choose one stable CRX ID for the development/unpacked build.
   - Generate and retain its private key outside the repository.
   - Put only the corresponding public key into the Chrome manifest generated
     by `wxt.config.ts`. Do not emit the Chrome `key` for other browser targets.
   - Record the resulting extension ID in non-secret environment/configuration
     for the development Clerk instance.
3. In Clerk, add `chrome-extension://<stable-id>` to the instance's allowed
   origins. Preserve every existing allowed origin when updating the setting.
4. Record environment-specific public values for the extension:
   - Clerk publishable key;
   - Clerk Frontend API origin;
   - Sync Host (`http://localhost` in Clerk's documented local setup and the
     Clerk Frontend API domain in production); and
   - Frieren API origin.
   Use WXT/Vite's `WXT_` prefix for values needed by extension code.
5. Give the extension only the required permissions:
   - `cookies` and `storage` for Clerk;
   - `activeTab` for the current page;
   - host permissions for the Sync Host, Clerk Frontend API, and exact Frieren
     API origin.
6. Add the real background auth wrapper and a minimal popup that proves:
   - signed out returns no token;
   - signing in through the web app is reflected in the extension;
   - `getToken()` returns a session token after the popup has been closed for
     more than one minute; and
   - signing out invalidates the extension session.

Keep the popup to "checking", "sign in", and "signed in" states. T3 replaces its
signed-in body with the Save to Read command. Do not write throwaway demo code.

Clerk's extension SDK officially targets Chrome. Keep every Clerk import and
browser-specific auth detail behind `lib/auth.ts`. WXT removes framework and
manifest lock-in, but a Firefox release still needs its own Clerk compatibility
proof. Do not spread Chrome-only APIs through the rest of the extension.

## Security checks

- No token is returned to a content script or written by application code to
  `browser.storage`.
- No token or Clerk secret appears in logs, query strings, screenshots, or
  generated bundles.
- The background worker performs authenticated fetches itself. Popup messages
  contain action data, never credentials.
- Host permissions name exact Just Computer and Clerk origins, not
  `https://*/`.
- The private CRX key is not committed. The public manifest key is safe to
  distribute and exists only to keep the extension ID stable.

## Acceptance

- Reloading or rebuilding the unpacked extension preserves its ID.
- `pnpm` builds an unpacked extension that Chrome can load from the documented
  output directory.
- A signed-in Just Computer user can close all Just Computer tabs, open the
  extension later, and the background worker can obtain a fresh session token.
- A signed-out user gets a clear `signed_out` result and a web sign-in link.
- The current Frieren Worker accepts that token as its existing
  `session_token`; T1 does not widen accepted token types.
- Automated tests isolate the tiny auth wrapper behind a mocked Clerk client;
  the real Sync Host flow has a recorded manual test procedure.

## References

- [Clerk Chrome Extension SDK](https://clerk.com/docs/reference/chrome-extension/overview)
- [Clerk Sync Host](https://clerk.com/docs/guides/sessions/sync-host)
- [`createClerkClient()` in a background service worker](https://clerk.com/docs/reference/chrome-extension/create-clerk-client)
- [Stable Chrome extension ID](https://clerk.com/docs/guides/development/configure-consistent-crx-id)
- [Chrome cross-origin requests and host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [WXT project structure](https://wxt.dev/guide/essentials/entrypoints.html)
- [WXT browser targets](https://wxt.dev/guide/essentials/target-different-browsers.html)
- [WXT unified extension API](https://wxt.dev/guide/essentials/extension-apis)

## Non-goals

- API keys, M2M tokens, custom JWT templates, or OAuth clients.
- A bespoke sign-in form in the extension.
- App/action permissions or token scopes.
- Chrome Web Store publication.
