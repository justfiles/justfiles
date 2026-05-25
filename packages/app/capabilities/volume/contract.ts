// App-facing Volume capability contract. Scoped filesystem access; the host
// owns the path-to-storage mapping. The requested `scopes` decide which
// volume is bound: `'app'` (or missing) is the per-app chroot, `'system'`
// is the user's root volume, and a path-like scope binds a prefix chroot.

export interface VolumeEntry {
	path: string
	type: 'file' | 'dir'
}

export interface VolumeCapability {
	readFile(input: { path: string }): Promise<Uint8Array>
	writeFile(input: { path: string; data: Uint8Array }): Promise<void>
	mkdir(input: { path: string; recursive?: boolean }): Promise<void>
	scan(input: { path: string }): Promise<VolumeEntry[]>
	exists(input: { path: string }): Promise<boolean>
}
