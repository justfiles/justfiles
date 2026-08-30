# References and prior art

The useful pattern is consistent: define actions once, give them stable names
and typed input, then adapt them to the surfaces where users already work.

## Clerk, WXT, and browsers

- [Clerk Chrome Extension SDK](https://clerk.com/docs/reference/chrome-extension/overview)
  supports popup, side-panel, and Sync Host configurations. Sync Host lets the
  extension reuse web-app authentication; OAuth in a popup is not supported.
- [Clerk Sync Host](https://clerk.com/docs/guides/sessions/sync-host) requires a
  configured sync host, extension host permissions, and the stable
  `chrome-extension://` origin in Clerk's allowed origins.
- [`createClerkClient()`](https://clerk.com/docs/reference/chrome-extension/create-clerk-client)
  can run with `background: true` in a Manifest V3 service worker, refresh the
  session, and return a fresh session token.
- [Stable CRX IDs](https://clerk.com/docs/guides/development/configure-consistent-crx-id)
  prevent Clerk origin configuration from breaking after an extension rebuild.
- [Clerk user API keys](https://clerk.com/docs/guides/development/machine-auth/api-keys)
  are opaque, user-bound, revocable bearer credentials suitable for CLI and
  local automation. They are not suitable as a secret embedded in an extension.
- [Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
  allow an extension service worker to call exact remote origins declared in
  `host_permissions`; a content script remains bound to the page origin.
- [`chrome.tabs`](https://developer.chrome.com/docs/extensions/reference/api/tabs)
  provides the active tab URL after the user invokes the extension.
- [WXT browser targets](https://wxt.dev/guide/essentials/target-different-browsers.html)
  produce separate builds for Chrome, Firefox, and other targets from one set
  of entrypoints.
- [WXT extension APIs](https://wxt.dev/guide/essentials/extension-apis) expose a
  unified `browser` object over the browser's native extension API.
- [WXT manifest configuration](https://wxt.dev/guide/essentials/config/manifest.html)
  generates per-browser manifests and converts common MV3 fields for MV2 when
  needed.

**Lesson used here:** authenticate in the background worker, keep tokens away
from content scripts, and request only exact host access. WXT owns extension
entrypoints and manifest generation. Clerk stays isolated behind the auth
module because its extension SDK officially targets Chrome.

## Action platforms

- [Readwise Reader API](https://readwise.io/reader_api) exposes programmatic
  document creation, while [Reader's add-content guide](https://docs.readwise.io/reader/docs/faqs/adding-new-content)
  covers the browser-extension and share surfaces. [Readwise MCP](https://readwise.io/mcp)
  exposes the same product to agents.
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
  uses a generic `POST /api/services/<domain>/<service>` shape instead of one
  bespoke route per integration.
- [Zapier's TypeScript integration model](https://docs.zapier.com/integrations/build-cli/typescript-integrations)
  declares actions with stable keys and input/output schemas, allowing one
  action definition to serve automation tooling and UI.
- [Apple App Intents](https://developer.apple.com/documentation/appintents)
  models an app capability once so system surfaces such as Shortcuts and Siri
  can discover it.
- [Raycast deeplinks](https://developers.raycast.com/information/lifecycle/deeplinks)
  are a good local launcher/parameter handoff, not a replacement for an
  authenticated mutation API.

**Lesson used here:** Just Computer's existing app ID, action name, metadata,
and schema hint should be the source. HTTP, browser UI, CLI, MCP, and deep links
are adapters, not new implementations of each app feature.

## Agents and MCP

- [Model Context Protocol tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  describes discoverable tools with JSON Schema input.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  standardises OAuth for HTTP transports; local stdio servers commonly receive
  configuration from their launcher instead.
- [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
  supports local and remote MCP servers and bearer/OAuth configuration for
  Streamable HTTP.

**Lesson used here:** start with three stable generic tools: list, inspect, and
run. They call the canonical gateway. A local stdio adapter is enough for Codex after
API-key support exists; a hosted MCP service can add standards-based OAuth when
there is a real need.

## Repository evidence

- [`AppController`](../../packages/app/app-controller.ts) is already the common
  kernel bridge.
- [Frieren's server app host](../../platform/frieren/worker/frieren.app.ts)
  already owns a controller over the user's Durable Object volume.
- [Frieren auth routing](../../platform/frieren/worker/index.ts) already maps a
  Clerk user to the correct Durable Object.
- [Read's `save` procedure](../../apps/read/src/app.ts) already accepts a URL or
  Markdown and owns duplicate handling.
- [The internal generic `app` command](../../packages/agent/justbash/app.ts)
  already demonstrates the agent interaction this external surface should
  preserve.
- [The existing Clerk API-key verifier](../../platform/worker/src/worker/index.ts)
  is prior art inside this repository for T5.
