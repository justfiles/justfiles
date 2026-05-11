// Type-level tests: keep `AppRelay` aligned with the wire registries.
// `sendRpc` mirrors iframe→host RPC (`AppRpcRegistry`) and `onToolInvoke`
// receives host→iframe invocations (`AppHostRpcRegistry`'s
// `app.tool.invoke` params). Any drift between the registries and the
// relay surface fails the type checker.

import { test } from 'bun:test'
import type {
	AppLauncher,
	AppRelay,
	HostCallHandler,
	ToolInvokeHandler,
	ToolResultSender
} from './client.js'
import type { AppHostRpcRegistry, AppRpcError, AppRpcRequest, AppRpcResponse } from './protocol.js'

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

// `callIframe` is keyed off `AppHostRpcRegistry`. Picking a concrete method
// must resolve to the registry's params + result shapes so a drift between
// the registry and the relay surface fails the type checker.
type DescribeResult = AppHostRpcRegistry['app.agent.describe']['result']
declare const relay: AppRelay
type DescribeCallReturn = Awaited<ReturnType<typeof relay.callIframe<'app.agent.describe'>>>
type _CallIframeDescribeReturn = Expect<
	Equal<DescribeCallReturn, { result?: DescribeResult; error?: AppRpcError }>
>
type _CallIframeDescribeParams = Expect<
	Equal<Parameters<typeof relay.callIframe<'app.agent.describe'>>[1], object>
>

type _OnHostCallShape = Expect<Equal<Parameters<AppRelay['onHostCall']>[0], HostCallHandler | null>>

// AppLauncher exposes a stable shape — launch/close take no extra args.
type _LauncherLaunch = Expect<Equal<ReturnType<AppLauncher['launch']>, void>>
type _LauncherClose = Expect<Equal<Parameters<AppLauncher['close']>, []>>

test('AppRelay/AppLauncher contracts compile', () => {})
