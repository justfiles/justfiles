// Type-level tests: keep `AppRelay` aligned with the wire registries.
// `sendRpc` mirrors iframe→host RPC (`AppRpcRegistry`) and `onToolInvoke`
// receives host→iframe invocations (`AppHostRpcRegistry`'s
// `app.tool.invoke` params). Any drift between the registries and the
// relay surface fails the type checker.

import { test } from 'vitest'
import type { AppLauncher, AppRelay, ToolInvokeHandler, ToolResultSender } from './client.js'
import type { AppHostRpcRegistry, AppRpcRequest, AppRpcResponse } from './protocol.js'

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

type SendRpcParam = Parameters<AppRelay['sendRpc']>[0]
type SendRpcReturn = Awaited<ReturnType<AppRelay['sendRpc']>>

type _SendRpcTakesAppRpcRequest = Expect<Equal<SendRpcParam, AppRpcRequest>>
type _SendRpcReturnsAppRpcResponse = Expect<Equal<SendRpcReturn, AppRpcResponse>>

type ToolInvokeParams = AppHostRpcRegistry['app.tool.invoke']['params']
type ToolInvokeHandlerParams = Parameters<ToolInvokeHandler>

type _ToolInvokeHandlerCallId = Expect<
	Equal<ToolInvokeHandlerParams[0], ToolInvokeParams['callId']>
>
type _ToolInvokeHandlerName = Expect<Equal<ToolInvokeHandlerParams[1], ToolInvokeParams['name']>>
type _ToolInvokeHandlerInput = Expect<Equal<ToolInvokeHandlerParams[2], ToolInvokeParams['input']>>

type _OnToolInvokeShape = Expect<
	Equal<Parameters<AppRelay['onToolInvoke']>[0], ToolInvokeHandler | null>
>

type SendToolResultParams = Parameters<ToolResultSender>
type _ToolResultCallIdIsString = Expect<Equal<SendToolResultParams[0], string>>

type _NotifyReload = Expect<Equal<Parameters<AppRelay['notifyIframeReload']>, []>>

// AppLauncher exposes a stable shape — launch/close take no extra args.
type _LauncherLaunch = Expect<Equal<ReturnType<AppLauncher['launch']>, void>>
type _LauncherClose = Expect<Equal<Parameters<AppLauncher['close']>, []>>

test('AppRelay/AppLauncher contracts compile', () => {})
