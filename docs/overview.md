---
title: Monorepo Overview
description: High-level map of the Ghostore apps and packages.
---

# Monorepo Overview

Ghostore is organized around a small set of host apps and shared packages.

## Hosts

- [Frieren](/frieren/) is the browser/cloud host.
- [Quay](/quay/) is the native macOS host.

## Shared packages

- [`@justfiles/app`](/app/) defines the app runtime and SDK.
- [`@justfiles/fs`](/fs/) defines the filesystem substrate.
- [`@justfiles/design`](/design/) defines shared CSS tokens and platform styling.

## Core flow

1. A host creates a `@justfiles/fs` volume.
2. The host creates a `@justfiles/app` kernel over that volume.
3. Apps are installed as bundles into the volume.
4. App GUIs dispatch messages to the kernel.
5. Reducers run in a sandbox and return new state plus optional effects.
6. The kernel resolves host capabilities and persists state.
