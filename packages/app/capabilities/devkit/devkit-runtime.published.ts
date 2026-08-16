import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The workspace builds the sysroot from SDK source. The npm package has no source,
// so its build bakes the same files beside this module and this form copies them.
const baked = join(import.meta.dirname, '..', '..', 'devkit-sysroot')

export async function writeSysroot(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true })
	await cp(baked, root, { recursive: true })
}
