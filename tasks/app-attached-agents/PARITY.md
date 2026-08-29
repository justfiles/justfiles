# Phase 7 parity record

The automated parity conversation sends `what am I looking at?` to a Files app
session through Frieren-shaped and Mac-shaped adapters. Both sessions receive the
same `# attached app` prompt block and write under
`/system/agents/app.justfiles.files/sessions/`.

The complete prompts should differ. Frieren adds expression instructions, its OS
state adapter and image tools when image generation is available. Mac adds the
`read_doc` tool and docs prompt, and its app controller opens native windows. Each
host also resolves its own AI backend and timezone. These injected parts do not
change app orientation or transcript ownership.

The checks live in:

- `packages/agent/sessions.test.ts` for the scripted conversation, prompt block and
  transcript path
- `packages/ui/src/attached-agent-layout.test.ts` for the shared placement boundary
- `platform/frieren/src/os/client.test.ts` for in-window notices
- `platform/mac/daemon/server.bun.test.ts` for in-window delivery without a launcher
  notification
