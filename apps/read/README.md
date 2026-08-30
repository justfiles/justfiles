# Read

A read-later viewer over the shared `/reading` folder. The folder owns the documents and
`info.json` sidecars. The app keeps only a derived list, the open item, and the current text
selection in reducer state.

Item folders keep readable title-based names. A hidden `/.index` tree maps SHA-256 identities to
those folders, so repeated URLs, pasted text, and PDFs can be found without scanning the library.
`refresh` adds missing index entries for folders saved by older versions.

```sh
pnpm --filter @justfiles/app-read dev
pnpm --filter @justfiles/app-read build
```

URL extraction uses the host's `reader` capability. Pasted Markdown and files added through Files
work without network access.

Press Command-V or Control-V anywhere in the app to save a URL, a PDF, or text with at least 200
characters. Saving a URL already in the library opens the existing item instead of fetching it again.
