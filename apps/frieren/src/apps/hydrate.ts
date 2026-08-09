import type { Kernel } from '@justfiles/app'

export async function hydrateInstalledAppBundles(getKernel: () => Promise<Kernel>): Promise<void> {
	const kernel = await getKernel()
	const manifests = await kernel.list()
	await Promise.all(
		manifests.map(async (manifest) => {
			const app = await kernel.app(manifest.id)
			// Prefetch the executable halves only; the Dock renders icons over HTTP,
			// so a hydrated icon blob would have no reader.
			//
			// For a hosted app this warms the mount instead of the blob store — the read
			// fetches from the origin through the service worker cache, which is what
			// makes it launchable offline later. Same call, both shapes.
			const paths = [manifest.app, manifest.gui].filter((p): p is string => Boolean(p))
			await Promise.all(paths.map((path) => app.read(path).catch(() => undefined)))
		})
	)
}
