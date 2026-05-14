// Public surface for app authors and host integrators. Pure types and
// helpers — no transport, no persistence.

export type { AppHandle, LoadAppOptions } from './app-loader.ts'
export { loadApp } from './app-loader.ts'
export type {
	ActiveApp,
	AppLauncher,
	AppRelay,
	InstalledApp,
	ToolInvokeHandler,
	ToolResultSender
} from './client.ts'
export type {
	App,
	AppCapabilityMap,
	Capabilities,
	Host,
	Manifest as AppManifest,
	Volume
} from './contract.ts'
export {
	APP_CONTRACT_VERSION,
	defineApp,
	ManifestSchema as AppManifestSchema,
	NotFoundError
} from './contract.ts'
export {
	APP_PERMISSIONS,
	type AppPermission,
	FORMAT_VERSION,
	type Manifest,
	ManifestSchema,
	PermissionSchema
} from './format.ts'
export type { AppHost } from './host.ts'
export type { CreateHostOptions, VolumeBackend } from './host-factory.ts'
export { createHost } from './host-factory.ts'
export type { LoadManifestOptions } from './manifest-loader.ts'
export { isNewManifest, loadManifest } from './manifest-loader.ts'
export {
	APP_RPC_ERROR,
	APP_RPC_PERMISSION,
	type AppCapabilities,
	type AppRpcError,
	type AppRpcMethod,
	type AppRpcParams,
	type AppRpcRegistry,
	type AppRpcRequest,
	type AppRpcResponse,
	type AppRpcResult,
	type RequestId
} from './protocol.ts'
