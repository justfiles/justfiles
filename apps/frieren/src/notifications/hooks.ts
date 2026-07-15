import { useSyncExternalStore } from 'react'
import { type NotificationEntry, type NotificationSnapshot, notificationStore } from './store'

// The center + pill read the store through `useSyncExternalStore` (the same
// BehaviorSubject pattern as the agent client).
export function useNotifications(): NotificationSnapshot {
	return useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot)
}

// The one item the pill surfaces — most-urgent-then-newest, undismissed.
export function useActiveNotification(): NotificationEntry | null {
	return useNotifications().active
}
