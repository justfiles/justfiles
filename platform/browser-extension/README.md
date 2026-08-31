# Just Computer browser extension

This WXT package builds the Chrome MV3 **Just Computer** extension. It shares the existing Just
Computer Clerk session through Sync Host and saves the active HTTP or HTTPS page to Read through
the generic app-actions API. The background worker asks Clerk for a fresh session token for every
request. Tokens stay in the background worker.

## Development

From the repository root:

```sh
pnpm install
pnpm --filter @justfiles/browser-extension dev
```

WXT opens a temporary Chrome profile with the extension installed. Keep the command running for
popup hot reload and automatic background-worker reloads. Chrome should show extension ID
`gkmnaaoiibnpeoillhpcfjdbdgmgfgai`; no manual **Load unpacked** step is needed.

The public development and production values live in `.env.development` and `.env.production`.
Do not add a Clerk secret key, session token, API key, or CRX private key to either file. The
development CRX private key is kept outside the repository at
`~/.config/justfiles/browser-extension/development.pem`.

Build unpacked targets with:

```sh
pnpm --filter @justfiles/browser-extension build
pnpm --filter @justfiles/browser-extension build:firefox
```

The outputs are `.output/chrome-mv3` and `.output/firefox-mv2`. The Firefox build omits Chrome's
manifest `key`; Clerk support on Firefox still needs its own compatibility proof.

## Manual check

1. Start Frieren with `pnpm dev` and start the extension with the development command above.
2. In the Chrome profile WXT opened, confirm the extension ID matches the value above.
3. Open the popup. It should show **Sign in to Just Computer** without displaying a token.
4. Select **Sign in**, complete the normal Just Computer web sign-in, then close that tab.
5. Open an HTTP or HTTPS page and reopen the popup. It should show the page and **Save to Read**.
6. Select **Save to Read**, then open Read and confirm that the saved page appears.
7. Open `chrome://extensions`, inspect Just Computer's service worker, stop it, and repeat the save
   with another page. The worker should restart and the save should succeed.
8. Open a `chrome:` page. The popup should explain that only HTTP and HTTPS pages can be saved.
9. Close the popup and every Just Computer tab. Wait more than one minute, then reopen the popup.
   It should still show **Save to Read** because the background worker fetched a fresh token.
10. Sign out through the Just Computer web app, close that tab, then reopen the popup. It should
    return to **Sign in to Just Computer**.

Production Sync Host requires the same extension ID in the production Clerk instance's allowed
origins before release.
