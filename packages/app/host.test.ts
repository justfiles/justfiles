// Type-level tests: ensure `AppHost.dispatch` stays in lockstep with
// `AppRpcRegistry`. If a new method is added to the registry, the
// `AppRpcRequest`/`AppRpcResponse` union widens and these assertions still
// hold; if the dispatch signature drifts (e.g. takes a different request
// shape, or returns something narrower than `AppRpcResponse`), the
// compiler fails here before runtime.

import { test } from 'bun:test'
import type { AppHost, AppRpcMethod, AppRpcRequest, AppRpcResponse, RequestId } from './index.js'

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

type DispatchParam = Parameters<AppHost['dispatch']>[0]
type DispatchReturn = Awaited<ReturnType<AppHost['dispatch']>>

type _DispatchTakesAppRpcRequest = Expect<Equal<DispatchParam, AppRpcRequest>>
type _DispatchReturnsAppRpcResponse = Expect<Equal<DispatchReturn, AppRpcResponse>>

// Every method in the registry must be accepted by dispatch — proven by
// constructing the request union and asserting it's a subtype of the param.
type _EveryMethodCoveredByDispatch = Expect<
	Extract<AppRpcRequest, { method: AppRpcMethod }> extends DispatchParam ? true : false
>

// Static identity checks on the lifecycle members so a stray refactor
// (e.g. swapping `current` for a promise-returning version) trips the build.
type _Current = Expect<Equal<ReturnType<AppHost['current']>, { id: string } | undefined>>
type _Launch = Expect<Equal<Parameters<AppHost['launch']>, [string]>>
type _Close = Expect<Equal<Parameters<AppHost['close']>, []>>

// The `RequestId` import is referenced only for documentation: dispatch's
// request id field is typed as `RequestId` via the registry.
type _RequestIdShape = Expect<Equal<RequestId, AppRpcRequest['id']>>

test('AppHost contract compiles', () => {})
