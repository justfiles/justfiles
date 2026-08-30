---
status: todo
depends_on: T3
milestone: 1
---

# T4: Prove Read end to end

## Result

Milestone 1 is demonstrated against the deployed Frieren environment: an
installed Just Computer extension authenticates, invokes the generic action
gateway, and a saved page appears in Read.

This task is integration, hardening, and documentation. Do not add a second
feature while proving the first.

## Test accounts

Use two Clerk test users to prove account isolation. Each user must have opened
Frieren and completed one successful built-in sync before the test. Record that
prerequisite in the extension's development README.

If the account has not synced Read, the gateway must return:

```json
{
	"error": {
		"code": "app_not_installed",
		"message": "Open Just Computer once to finish setting up Read, then retry."
	}
}
```

Do not solve server-side built-in materialisation in this task.

## End-to-end matrix

Run and record each case:

| Case | Expected result |
| --- | --- |
| Signed out, valid web page | Extension offers sign-in; no gateway request |
| Signed in, valid article | One Read item appears with the source URL |
| Same URL saved twice | Read's existing duplicate behaviour; no duplicate item |
| Frieren tab closed | Save still succeeds through the Durable Object |
| Extension service worker restarted | Fresh token is acquired and save succeeds |
| `chrome://extensions` tab | Extension rejects it locally |
| Missing/invalid token | Gateway returns 401 and no item is written |
| Malformed action params | Gateway returns `invalid_params` and no item is written |
| Account without Read synced | Actionable `app_not_installed` error |
| User A saves while User B is signed in separately | Item exists only in User A's library |
| Reader extraction fails | Extension shows a retryable action error; no false success |

Use a stable public test article rather than a paywalled or bot-protected page.
Automated integration tests must mock the reader capability and network; only
the recorded manual check hits a real page.

## UX hardening

Fix only issues that block the matrix:

- the popup must distinguish signed out, unsupported URL, missing Read, bad
  request, and action failure;
- the save button must not announce success before the action returns;
- retry must re-read the active tab and obtain a fresh token; and
- closing the popup during a save must not expose a token or corrupt extension
  state. It is acceptable for the server request to finish without a visible
  acknowledgement.

Do not add polling, a durable extension queue, notifications, or background
retries. Those change delivery semantics and need a separate product decision.

## Milestone acceptance

The final handoff includes:

- the exact build command;
- the directory to choose in Chrome's **Load unpacked** dialog;
- the expected stable extension ID;
- required public environment values and where to obtain them;
- the Clerk Dashboard setup from T1;
- a screen recording or written evidence for the end-to-end matrix; and
- a curl example showing the same generic endpoint independently of the
  extension.

Milestone 1 is done only when the item is visible in Read, not merely when the
HTTP request returns 200.

## Exit review

Before moving to T5, confirm the seam really is generic:

- no Read-specific route exists;
- no Read-specific auth rule exists;
- no Read-specific logic exists in the generic background/client modules; and
- another app/action can be invoked with only different IDs and params.

## Non-goals

- API keys, CLI, MCP, URL schemes, action permissions, or app discovery UI.
- Guaranteed extraction of paywalled or bot-protected pages.
- Cold-account server-side app installation.
