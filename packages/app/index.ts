// Public surface for app authors and host integrators. Pure types and
// helpers — no transport, no persistence.

export {
	APP_PERMISSIONS,
	type AppPermission,
	FORMAT_VERSION,
	type Manifest,
	ManifestSchema,
	PermissionSchema
} from './format.js'
export {
	APP_RPC_ERROR,
	APP_RPC_PERMISSION,
	type AppCapabilities,
	type AppCapabilityMap,
	type AppRpcError,
	type AppRpcMethod,
	type AppRpcParams,
	type AppRpcRegistry,
	type AppRpcRequest,
	type AppRpcResponse,
	type AppRpcResult,
	type RequestId
} from './protocol.js'
