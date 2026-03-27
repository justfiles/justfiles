# CLI Development Setup

To use the CLI directly from source during development:

```sh
cd apps/cli
bun run build
bun link
```

This creates a global symlink so `ghostore` is available system-wide and points to the local `dist/index.mjs`.

After making changes, rebuild:

```sh
bun run build
```

Or watch mode for automatic rebuilds:

```sh
bunx tsdown --watch
```

To unlink:

```sh
bun unlink
```
