// App-facing Volume capability contract. Scoped filesystem access; the host
// owns the path-to-storage mapping.

export interface VolumeCapability {
	readFile(input: { path: string }): Promise<Uint8Array>
	writeFile(input: { path: string; data: Uint8Array }): Promise<void>
}
