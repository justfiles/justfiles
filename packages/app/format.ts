// Wire format for an app package. The shape is identical regardless of how
// the package reaches the host: an npm install, a workspace dep, or an
// unzipped user upload. Adapters expose an `AppPackageSource` (see ./host);
// `loadAppPackage` is the single ingestion point.
//
// The package's `package.json#main` points at the backend ESM module; the
// directory containing `main` is the *content root* and every file inside
// that directory ships with the app. `manifest.json` describes the layout
// (`backend` filename, `entry` HTML), and the host validates against
// `ManifestSchema` before trusting any of it.

import Type from 'typebox'

export const FORMAT_VERSION = 1

// TODO(signing): zip submissions from untrusted users need integrity + origin
// proof. Likely shape: a detached signature file (e.g. `signature.bin`)
// covering manifest.json plus a content-addressed file list. Bump
// FORMAT_VERSION to 2 when adding; old packages stay readable at 1 for
// compat. npm packages don't need this — npm + dependency pinning is the
// trust boundary on that channel.
export const ManifestSchema = Type.Object({
	format: Type.Literal(FORMAT_VERSION),
	name: Type.String({ minLength: 1, maxLength: 128 }),
	description: Type.String({ maxLength: 1024 }),
	version: Type.String(),
	icon: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	entry: Type.String(),
	backend: Type.String()
})
export type Manifest = Type.Static<typeof ManifestSchema>
