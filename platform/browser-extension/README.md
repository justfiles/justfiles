# Just Computer browser extension

This WXT package builds the Chrome MV3 extension shell. It shares the existing Just Computer
Clerk session through Sync Host. The background worker asks Clerk for a fresh session token each
time it needs authentication. Tokens stay in the background worker.

## Development

From the repository root:

```sh
pnpm install
pnpm --filter @justfiles/browser-extension dev
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
`platform/browser-extension/.output/chrome-mv3-dev`. Chrome should show extension ID
`gkmnaaoiibnpeoillhpcfjdbdgmgfgai`.

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

## Manual Sync Host check

1. Start Frieren with `pnpm dev` and start the extension with the development command above.
2. Load or reload `.output/chrome-mv3-dev` in Chrome and confirm its ID matches the value above.
3. Open the popup. It should show **Sign in to Just Computer** without displaying a token.
4. Select **Sign in**, complete the normal Just Computer web sign-in, then close that tab.
5. Reopen the popup. It should show **Signed in**.
6. Close the popup and every Just Computer tab. Wait more than one minute, then reopen the popup.
   It should still show **Signed in** because the background worker fetched a fresh token.
7. Sign out through the Just Computer web app, close that tab, then reopen the popup. It should
   return to **Sign in to Just Computer**.

Production Sync Host requires the same extension ID in the production Clerk instance's allowed
origins before release.
