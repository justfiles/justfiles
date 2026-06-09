// frieren's app-store glue: built-in apps ship as static assets under
// `/appstore` (emitted by `vite-appstore.ts`), and the reconcile logic +
// catalog types now live in `@justfiles/app/builtins`. This module keeps only
// the frieren-specific asset addressing: the catalog schema tag, its served
// path, and the version-pathed per-file URL the server/client `read` use.

export const CATALOG_SCHEMA = 'frieren/appstore-catalog/v1'
export const CATALOG_PATH = '/appstore/catalog.json'

// Version-pathed so a release is immutable and permanently cacheable.
export function appFileUrl(app: { id: string; version: string }, path: string): string {
	return `/appstore/apps/${app.id}/${app.version}/${path}`
}
