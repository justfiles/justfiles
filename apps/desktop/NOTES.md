# desktop — notes

## Electron binary fails to install on Node >= 24.16 (silent)

**Symptom:** `pnpm dev` throws `Error: Electron uninstall` from electron-vite.
Under the hood, `electron`'s `install.js` postinstall downloads the binary zip
fine but extraction stops after the first large entry — `dist/` ends up with
only `LICENSES.chromium.html`, no `path.txt`. The process exits **0** with no
error, so pnpm reports the postinstall as "Done". electron-vite then can't find
`path.txt` and throws.

**Root cause:** a Node.js classic-stream backpressure-resume regression
(works on 24.15.0, broken 24.16.0 → 26.x, still open). It stalls the 6-year-old
`extract-zip@2.0.1` → `yauzl@2` chain that `electron`'s installer uses. Same bug
hit Playwright / Cypress / Puppeteer / electron-builder. Not an Electron or
electron-vite bug.

- nodejs/node#63487 — "Node 24.16.0: extract-zip hangs extracting"
- max-mapper/extract-zip#154 — "Zip extraction fail in Node 26.1.0"

**Fix (in repo):** force the patched yauzl under extract-zip, via
`pnpm-workspace.yaml` (pnpm 11 ignores `pnpm.overrides` in package.json):

```yaml
overrides:
  'extract-zip>yauzl': '3.3.1'
```

Apply with `pnpm install --no-frozen-lockfile` (a plain `pnpm install` may
short-circuit with "Already up to date" and skip re-resolving the override).

**If it ever recurs** (override removed, or a stale partial extraction):

```sh
E=node_modules/.pnpm/electron@*/node_modules/electron
rm -rf $E/dist $E/path.txt && node $E/install.js
```
