# SolidJS Migration Evaluation for Ghostore

Date: March 25, 2026

## Executive Summary

SolidJS `v2.0.0-beta.0` is a real and significant beta release, but it is not yet a low-risk production target for this repository.

For this codebase, the main constraint is not Solid itself. The main constraint is ecosystem maturity around:

- TanStack Query / Router compatibility with Solid 2 beta
- Clerk integration quality and support level

Current recommendation:

- Do not migrate the production frontend from React to Solid 2 beta yet.
- A prototype or spike branch is viable.
- If migration becomes strategic, prefer waiting for clearer ecosystem support, especially from TanStack and Clerk.

## Current Frontend Scope

The current frontend is a non-trivial React app with several framework-level dependencies:

- React 19 app bootstrapping with Clerk, TanStack Query, and TanStack Router in [src/react-app/main.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/main.tsx#L1)
- Route tree in [src/react-app/router.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/router.tsx#L1)
- Auth-gated app shell and sidebar state in [src/react-app/AppShell.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/AppShell.tsx#L1)
- Draft editor flow in [src/react-app/App.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/App.tsx#L1)
- Memory detail page with multiple mutations in [src/react-app/MemoryPage.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/MemoryPage.tsx#L1)
- Custom ProseMirror integration in [src/react-app/Editor.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/Editor.tsx#L385)
- Sidebar sync/cache logic in [src/react-app/useSidebar.ts](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/useSidebar.ts#L36)
- Client-side memory loading/saving in [src/react-app/useMemory.ts](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/useMemory.ts#L4)
- Clerk prebuilt auth UI in [src/react-app/AuthWall.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/AuthWall.tsx#L1)

The `src/react-app` folder currently contains about 2,900 lines across 24 TypeScript/TSX files. This is large enough that migration cost is driven by framework and library replacement, not just JSX syntax changes.

## What Solid 2 Beta Changes

The Solid `v2.0.0-beta.0` release introduces meaningful runtime and API changes. Notable items from the release notes:

- Async is now first-class in the reactive graph
- `<Loading>` is introduced for initial readiness behavior
- `isPending(...)` is introduced for in-flight background work
- `action(...)`, `createOptimistic`, and `createOptimisticStore` are introduced for mutation flows
- Scheduling changes: updates are microtask-batched, and reads do not update until the batch flushes
- `createEffect` is split into compute/apply semantics
- `onMount` is replaced by `onSettled`
- `Index` is replaced by `<For keyed={false}>`
- Stores become draft-first by default
- DOM usage changes, including replacement of `use:` directives and cleanup of class handling

The release notes also explicitly state that:

- there will be bugs and rough edges
- the beta phase is intended to build migration strategies and extend 2.0 into the broader ecosystem

Source:

- https://github.com/solidjs/solid/releases/tag/v2.0.0-beta.0

## Benefits If Adopted Successfully

If Ghostore eventually adopts Solid successfully, likely gains include:

- More granular UI updates than React’s component rerender model
- Lower client runtime overhead in interactive views
- Cleaner handling of some mount-once and stable-reference patterns
- Potentially simpler local reactive state for sidebar, palette, and editor-adjacent UI

This benefit is real for an app like Ghostore, which has:

- an interactive editor
- cached sidebar trees
- command palette search
- local settings and UI toggles
- sync status and mutation-heavy screens

However, these are performance and ergonomics gains, not unique product capabilities.

## TanStack Compatibility Assessment

### What is verified

TanStack has official Solid framework support today:

- Solid Query docs exist
- Solid Router docs exist

Sources:

- https://tanstack.com/query/latest/docs/framework/solid
- https://tanstack.com/router/v1/docs/framework/solid

### What is not yet reassuring

The current `@tanstack/solid-query` package metadata on the TanStack Query `main` branch still targets Solid 1.x:

- peer dependency: `solid-js ^1.6.0`
- dev dependency: `solid-js ^1.9.7`

Source:

- https://raw.githubusercontent.com/TanStack/query/main/packages/solid-query/package.json

### Interpretation

This does not prove Solid 2 beta is incompatible. It does show that explicit Solid 2 beta support is not yet declared in the package metadata.

Because Solid 2 beta changes scheduling, effect behavior, and lifecycle semantics, that gap matters. Query libraries are often sensitive to these details.

Conclusion for TanStack:

- Solid 2 beta with TanStack is plausible
- It is not yet a clearly supported, low-risk path
- Production adoption should wait for explicit compatibility signals or tested releases

## Clerk Compatibility Assessment

### What is verified

Clerk’s official SDK reference currently lists:

- React as an official frontend SDK
- React Router as an official frontend SDK
- TanStack React Start as an official frontend SDK
- SolidJS under community-maintained SDKs

Source:

- https://clerk.com/docs/reference/overview

### Community Solid adapter

Clerk links SolidJS users to:

- https://github.com/spiritledsoftware/clerk-solidjs

That repository describes itself as:

- an unofficial community-led port of the Clerk React SDK
- near-complete feature parity with `@clerk/clerk-react`
- missing some features such as custom pages for UI components

It also currently states prerequisites as:

- SolidJS `>=1`
- SolidStart `>=1`

Source:

- https://github.com/spiritledsoftware/clerk-solidjs

### Interpretation

I could not verify an explicit Solid 2 beta compatibility statement for `clerk-solidjs`.

That means:

- Solid 2 beta + Clerk is not blocked in principle
- but it depends on an unofficial adapter
- and there is no clear, primary-source signal that the adapter is already aligned with Solid 2 beta semantics

For this repo, that is a major risk because Clerk is central to bootstrapping and auth UI:

- [src/react-app/main.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/main.tsx#L1)
- [src/react-app/AppShell.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/AppShell.tsx#L80)
- [src/react-app/AuthWall.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/AuthWall.tsx#L1)
- [src/react-app/MemoryEditor.tsx](/Users/Xiaoxing.Hu@nib.co.nz/workspace/ghostore/src/react-app/MemoryEditor.tsx#L1)

Conclusion for Clerk:

- This is the weakest part of the migration path
- It is viable only if you accept community-adapter risk
- It is not the right foundation for a low-risk production rewrite today

## Viability for Ghostore

### Is adopting Solid 2 beta technically possible?

Yes.

The app can be rewritten to Solid. The backend and API surface are not the problem. The ProseMirror editor is mostly imperative and should be portable. Tailwind/DaisyUI styling can remain.

### Is it a good production migration target right now?

Not yet.

Reasons:

- Solid 2 is still beta and explicitly ecosystem-catch-up oriented
- TanStack Solid support exists, but Solid 2 compatibility is not clearly declared
- Clerk support for Solid is community-maintained, not official
- This app has enough auth, routing, sync, and local-state complexity that migration risk is real

### Is it a good prototype target?

Yes.

A prototype branch makes sense if the goals are:

- validate perceived performance gains
- test Solid 2 mental model fit
- measure migration friction in real code
- specifically prove or disprove auth and query viability

## Recommended Path

### Short term

Stay on React for production.

### If you want to explore Solid

Run a bounded spike with these rules:

- Keep the existing backend and API unchanged
- Rebuild only the client shell first
- Prove Clerk authentication before migrating feature pages
- Prove TanStack Query behavior under Solid 2 beta before deeper adoption
- Leave the editor for later, since it is not the first ecosystem risk

### Decision threshold for real migration

I would only recommend a production migration when all of the following are true:

- TanStack explicitly supports Solid 2 in the Solid adapters, or you have verified it thoroughly in your app
- `clerk-solidjs` clearly supports Solid 2, or Clerk ships official Solid support
- the prototype demonstrates enough measurable benefit to justify the rewrite

## Final Recommendation

Solid 2 beta is a viable experimental path for Ghostore.

It is not yet a high-confidence production migration path.

If you adopt it now, you are not mostly betting on Solid. You are betting on:

- beta-stage framework evolution
- adapter compatibility
- community-maintained auth integration

That is a reasonable engineering bet for a spike branch.
It is not the right default bet for the main product frontend today.

## Sources

- Solid 2 beta release notes: https://github.com/solidjs/solid/releases/tag/v2.0.0-beta.0
- Solid 2 beta docs / migration references:
  - https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/MIGRATION.md
  - https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/05-async-data.md
- TanStack Query Solid docs: https://tanstack.com/query/latest/docs/framework/solid
- TanStack Router Solid docs: https://tanstack.com/router/v1/docs/framework/solid
- TanStack Query package metadata: https://raw.githubusercontent.com/TanStack/query/main/packages/solid-query/package.json
- Clerk SDK references: https://clerk.com/docs/reference/overview
- Community Solid Clerk adapter: https://github.com/spiritledsoftware/clerk-solidjs
