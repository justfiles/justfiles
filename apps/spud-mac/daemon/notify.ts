import type { Channel } from '@justfiles/app/capabilities/notify'

// The host's notification convergence point. The kernel's `notify` capability (apps)
// and the agent hand notifications here; `main.ts` binds the real sink — fan out to the
// launcher `/system` sockets — once the server is up (a notification can only reach a
// launcher over a socket the server owns). The no-op default keeps the kernel usable
// before the server starts and in tests.
let sink: Channel = () => {}

// The stable reference wired into the kernel at construction. It forwards to whatever
// sink `main.ts` later binds, so the capability can be built before the server exists.
export const notificationChannel: Channel = (notification) => sink(notification)

export function setNotificationChannel(next: Channel): void {
	sink = next
}
