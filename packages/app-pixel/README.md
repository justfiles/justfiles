# @spud-computer/pixel

An indexed pixel-art editor for the [spud](https://spud.computer) app store,
built on [`@justfiles/app`](https://www.npmjs.com/package/@justfiles/app). The
artwork lives in reducer state as a palette-indexed char grid, so an agent can
read and edit the picture directly.

```sh
pnpm install
pnpm dev      # develop
pnpm build    # emit dist/manifest.json, dist/app.js, dist/gui.js
```

Bundle id: `computer.spud.pixel`.

## Agent text I/O

The canvas is a palette-indexed char grid, so an agent reads and writes it as
plain text — no JSON coordinate lists.

**See the canvas** — `show` returns the `.pixel` text (palette legend + grid),
the same format `setGrid` accepts:

```sh
app run --id computer.spud.pixel show
app run --id computer.spud.pixel show ruler=true   # overlay 0-based col/row numbers (read-only view)
```

**Draw** — pipe a char grid into `setGrid` via `--stdin grid` (heredoc or `|`):

```sh
app run --id computer.spud.pixel setGrid --stdin grid <<'EOF'
................
..666......666..
.66666....66666.
.66666666666666.
EOF
```

Per cell: `0-9 a-z A-Z` set that palette index (1..62); `.` sets transparent
(erases); a **space** leaves the existing pixel untouched (skip); blank lines and
`# comment` lines are ignored. Pass `x`/`y` to stamp a patch at an origin without
redrawing the whole canvas (clipped to the edges; short rows skip their missing
right-hand cells):

```sh
printf '.66.\n.66.' | app run --id computer.spud.pixel setGrid x=6 y=8 --stdin grid
```

If the piped text is a full `.pixel` document (first line `pixel <version>`) it
replaces the whole canvas and palette (`x`/`y` ignored) — e.g. paste back an
edited `show` dump.
