---
title: '@justfiles/design'
description: Shared CSS tokens, shell components, and platform styling.
---

# `@justfiles/design`

Source: `packages/design`

`@justfiles/design` is the shared CSS package for host chrome and app defaults.

## Exports

- `@justfiles/design/design.css` — design tokens and `ds-*` shell classes.
- `@justfiles/design/mac.css` — mac-style platform defaults layered on top of `design.css`.
- `@justfiles/design/mac` — alias for `mac.css`.

## Model

- Tokens live on `:root` and include surfaces, text, rules, controls, fonts, menubar, desktop, dock, focus, accent, and danger colors.
- Dark mode is token-driven via `prefers-color-scheme`.
- Shell components use `ds-*` classes for menus, menubar, desktop, dock, windows, and related host UI.
- Platform defaults in `mac.css` are wrapped in `:where()` so they have zero specificity and stay easy for apps to override.
- A `<button data-primary>` is the default button (the one Return fires) and gets the `--accent` treatment; plain `<button>` stays bare.

## Key files

- `packages/design/design.css` — tokens and shared shell classes.
- `packages/design/mac.css` — mac platform stylesheet.
- `packages/design/package.json` — package exports.

## TODO

- Document the token list.
- Add screenshots for host chrome.
- Define rules for when to add a `ds-*` class versus app-local CSS.
