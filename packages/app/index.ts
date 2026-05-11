// Public surface for app authors and host integrators. Pure types and
// helpers — no transport, no persistence.

export type { AppHandle, LoadAppOptions } from './app-loader.js'
export { loadApp } from './app-loader.js'
export type {
	ActiveApp,
	AppLauncher,
	AppRelay,
	InstalledApp,
	ToolInvokeHandler,
	ToolResultSender
} from './client.js'
export type {
	App,
	AppCapabilityMap,
	Capabilities,
	Host,
	Manifest as AppManifest,
	Volume
} from './contract.js'
export {
	APP_CONTRACT_VERSION,
	defineApp,
	ManifestSchema as AppManifestSchema,
	NotFoundError
} from './contract.js'
export {
	APP_PERMISSIONS,
	type AppPermission,
	FORMAT_VERSION,
	type Manifest,
	ManifestSchema,
	PermissionSchema
} from './format.js'
export type { AppHost } from './host.js'
export type { CreateHostOptions, VolumeBackend } from './host-factory.js'
export { createHost } from './host-factory.js'
export type { LoadManifestOptions } from './manifest-loader.js'
export { isNewManifest, loadManifest } from './manifest-loader.js'
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
} from './protocol.js'
