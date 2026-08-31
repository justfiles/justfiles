---
status: in progress
depends_on: T1, T2
milestone: 1
---

# T3: Build the Just Computer browser extension

## Result

An unpacked Manifest V3 extension named **Just Computer** uses the generic
action gateway. Its first command saves the active page to Read.

The extension is a platform client, not a Read extension. Read-specific values
must stay at the leaf of the call.

## Location and shape

Continue the WXT package at `platform/browser-extension` created by T1. Keep
the code plain TypeScript and DOM. React adds nothing to this popup.

Keep this structure small:

```text
platform/browser-extension/
  package.json
  tsconfig.json
  wxt.config.ts
  entrypoints/
    background.ts       # WXT background entrypoint and authenticated requests
    popup/
      index.html
      main.ts           # signed-out, ready, saving, saved, error states
  lib/
    auth.ts             # Clerk client wrapper created by T1
    client.ts           # list, inspect, run HTTP operations
    save-page.ts        # justfiles.read/save mapping
```

Follow WXT's file-based entrypoint conventions. Do not add a content script,
options page, side panel, state library, router, or design system.

## Manifest

Use Manifest V3 and request only:

- `activeTab`;
- Clerk's required `cookies` and `storage`; and
- exact host permissions for the configured Clerk origins and Frieren API
  origin.

Use the public CRX key from T1 so the unpacked extension ID is stable. Do not
request access to all websites: the extension reads the active tab URL after a
toolbar gesture and sends it from the background worker.

Generate the manifest through `wxt.config.ts`. Keep the Chrome `key` and any
future browser-specific permissions inside WXT's per-browser manifest function.
Use the unified `browser` export from `wxt/browser`, and call extension APIs only
inside WXT entrypoint functions.

## Generic client

`client.ts` owns the base URL, JSON transport, bearer header, and error parsing.
It exposes only:

```ts
list(): Promise<AppSummary[]>
inspect(appId: string): Promise<AppInspection>
run(appId: string, action: string, params: unknown): Promise<unknown>
```

The background worker obtains a fresh token immediately before each call and
performs the fetch itself. The popup sends a message such as
`{ type: 'run', appId, action, params }`; it never receives the token.

Keep `save-page.ts` to this mapping:

```ts
run('justfiles.read', 'save', { input: url })
```

Do not reproduce Read's URL normalisation, duplicate handling, readability
fetching, or persistence.

## Popup behaviour

The popup is one small state machine:

| State | UI |
| --- | --- |
| Loading | "Checking Just Computer..." |
| Signed out | "Sign in to Just Computer" button opening the web app |
| Unsupported tab | Explain that only `http:` and `https:` pages can be saved |
| Ready | Show page title/host and **Save to Read** |
| Saving | Disable the button and show progress |
| Saved | "Saved to Read" |
| Error | Short message plus retry; preserve `app_not_installed` remediation |

Do not render the raw session token, request body, API result, or stack trace.
Ignore repeat clicks while one save is in flight. It is fine for a later click
to repeat the request because Read deduplicates a URL.

The sign-in button opens the existing web sign-in in a full tab. After the user
returns, reopening the popup reflects the synced Clerk session. Do not attempt
to keep the popup alive through authentication.

## Tests

Unit-test pure boundaries with mocked extension and fetch APIs:

- `http:` and `https:` URLs are accepted; `chrome:`, `file:`, empty, and absent
  URLs are rejected before the network call;
- save maps to `justfiles.read/save` with `{ input: url }` exactly;
- the background worker adds a fresh bearer token and JSON content type;
- signed out never calls the gateway;
- an in-flight save cannot be submitted twice;
- gateway error codes map to useful popup states; and
- no response sent to the popup contains a token.

Use WXT's browser test support or `@webext-core/fake-browser` instead of a
hand-written global `chrome` mock.

Manual development proof:

1. `pnpm` install/build command produces an unpacked Chrome directory.
2. Loading that directory at `chrome://extensions` shows **Just Computer**.
3. The stable extension ID matches T1's Clerk allowed origin.
4. The popup works after its service worker has been suspended and restarted.

Also run a Firefox build to catch accidental Chrome API use. Firefox runtime
authentication is not part of Milestone 1 because Clerk's SDK is Chrome-specific;
record any auth compatibility issue instead of hiding it behind conditionals.

## Acceptance

- The package passes typecheck and tests through the monorepo scripts.
- A developer can follow a short README to build and load the unpacked
  extension without copying secrets into it.
- The popup calls only the generic client. Searching the transport/background
  code for `justfiles.read` finds nothing.
- The built extension contains the Clerk publishable key and CRX public key,
  but no secret key, session token, API key, or private key.

## Non-goals

- Chrome Web Store packaging, Firefox or Safari runtime support, context menus,
  keyboard shortcuts, badges, offline queues, pasted URLs, or multiple commands.
- Discovering and rendering arbitrary app actions in the popup.
- A shared API client package before a second consumer exists.

## References

- [WXT entrypoints](https://wxt.dev/guide/essentials/entrypoints.html)
- [Targeting different browsers](https://wxt.dev/guide/essentials/target-different-browsers.html)
- [WXT extension APIs](https://wxt.dev/guide/essentials/extension-apis)
- [WXT manifest generation](https://wxt.dev/guide/essentials/config/manifest.html)
