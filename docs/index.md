---
title: Ghostore Docs
description: Project documentation for the Ghostore monorepo.
---

# Ghostore Docs

This folder is the source of truth for the docs site. The Astro/Starlight shell in `apps/docs` renders these files.

## Map

| Area | Source | Role |
| --- | --- | --- |
| [Frieren](/frieren/) | `apps/frieren` | Web/cloud desktop, user profiles, sync, and agent runtime. |
| [Quay](/quay/) | `apps/quay` | Native macOS launcher and local daemon. |
| [`@justfiles/app`](/app/) | `packages/app` | App runtime, SDK, kernel, sandbox, and capabilities. |
| [`@justfiles/fs`](/fs/) | `packages/fs` | Storage primitives, path-based volume API, and sync. |
| [`@justfiles/design`](/design/) | `packages/design` | Shared CSS tokens and platform styling. |
