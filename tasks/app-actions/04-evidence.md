# T4 end-to-end evidence

Date: 2026-09-01  
Environment: deployed `https://justcomputer.app`, production Clerk, unpacked production Chrome
build

## Build under test

```sh
pnpm --filter @justfiles/browser-extension build
```

- Load unpacked: `platform/browser-extension/.output/chrome-mv3`
- Extension ID: `gkmnaaoiibnpeoillhpcfjdbdgmgfgai`
- Stable article: `https://www.w3.org/Provider/Style/URI`

## Production setup found during the run

- Clerk Native API was disabled. The extension's environment and client requests returned
  `native_api_disabled`, so the popup could not reuse the signed-in web session.
- Native API was enabled in the production Clerk instance. After reloading the extension, the
  popup authenticated and showed the active article.
- The public `https://justapps.run/store.json` catalog has no `justfiles.read` release. Booting
  the deployed app therefore cannot materialise Read for a test account. The first save reached
  the gateway and returned `app_not_installed`.
- The production Clerk instance has no designated T4 test users. No real user account was
  impersonated for testing.

## Matrix

| Case | Evidence | Status |
| --- | --- | --- |
| Signed out, valid web page | Requires an isolated production test user/session. | Blocked |
| Signed in, valid article | Popup authenticated, read the W3C article, and invoked the gateway; gateway returned `app_not_installed`. | Blocked by missing Read release |
| Same URL saved twice | Read cannot be installed from the deployed public catalog. | Blocked |
| Frieren tab closed | Read cannot be installed from the deployed public catalog. | Blocked |
| Extension service worker restarted | Chrome reloaded the worker; the reopened popup acquired a fresh session and returned to **Ready to save**. The save itself remains blocked by missing Read. | Partial pass |
| `chrome://extensions` tab | Popup showed **Only HTTP and HTTPS pages can be saved.** No gateway request was made. | Pass |
| Missing/invalid token | Direct POSTs to the generic endpoint returned `401 unauthorized` for both an absent token and an invalid bearer token. | Pass |
| Malformed action params | Gateway unit test proves `400 invalid_params`; a deployed authenticated check requires installed Read. | Automated pass; manual blocked |
| Account without Read synced | Live popup showed **Open Just Computer once to finish setting up Read, then retry.** | Pass |
| User A saves while User B is signed in separately | Requires two isolated production test users with Read installed. | Blocked |
| Reader extraction fails | The mocked extension network test receives retryable `action_failed` without announcing success. Read must also reject a failed save after recording it; that change is pending in `justfiles/app-read`. A deployed check requires installed Read. | Extension automated pass; Read fix pending; manual blocked |

## Independent gateway checks

The unauthenticated checks used the same generic endpoint as the extension:

```sh
curl -X POST \
	'https://justcomputer.app/api/v1/apps/justfiles.read/actions/save' \
	-H 'content-type: application/json' \
	--data '{"input":"https://www.w3.org/Provider/Style/URI"}'

curl -X POST \
	'https://justcomputer.app/api/v1/apps/justfiles.read/actions/save' \
	-H 'authorization: Bearer invalid' \
	-H 'content-type: application/json' \
	--data '{"input":"https://www.w3.org/Provider/Style/URI"}'
```

Both responses were:

```json
{
	"error": {
		"code": "unauthorized",
		"message": "authentication is required"
	}
}
```

## Remaining prerequisite

Publish `justfiles.read` into the public JustApps catalog, then create or designate two production
Clerk test users and boot deployed Just Computer once for each. Repeat every blocked or partial
manual case before marking T4 done.
