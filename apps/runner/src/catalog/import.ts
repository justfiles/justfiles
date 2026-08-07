import type { Resolved } from './refresh-app'

/**
 * Fetch, validate and extract one resolved release, then record it.
 *
 * Its own module because it is its own phase: kb/registry.md keeps detection and
 * fetching apart so that moving this onto a Queue consumer — one binding, its
 * own 15-minute wall clock, retries and backoff — stays a change to `refresh()`
 * and nothing else.
 *
 * The security-critical half. Treat every archive as hostile: see
 * kb/registry.md#import for the write ordering and kb/catalog.md#security-boundary
 * for the caps, the secret scan, and why the ZIP header's declared length is the
 * one number that must never be trusted.
 */
export async function importRelease(_env: CloudflareBindings, _id: string, _resolved: Resolved) {}
