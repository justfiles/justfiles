import Foundation
import UserNotifications

// A `notify` capability notification as quayd broadcasts it over the launcher socket
// ({type:'notification', notification:{…}}). Mirrors @justfiles/app's `Notification`;
// only the fields the native sink reads are decoded. `route` is Codable so a click
// can round-trip it back out of the banner's userInfo.
struct QuayNotification: Decodable {
	let id: String
	let source: String
	let kind: String
	let title: String
	let body: String
	let threadId: String?
	let route: Route?

	struct Route: Codable {
		let kind: String
		let id: String?
		let pane: String?
	}
}

// Wraps UNUserNotificationCenter: requests authorization once at launch, registers
// the per-kind categories, posts a banner (coalescing by threadId so a re-post
// replaces), and resolves a click back into the launcher via `onRoute`.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
	// Fired (main thread) when the user clicks a banner, with its route (or nil).
	var onRoute: ((QuayNotification.Route?) -> Void)?

	private let center = UNUserNotificationCenter.current()

	override init() {
		super.init()
		// The delegate must be set before the app finishes launching (Apple docs); the
		// launcher constructs this in a property initializer, which runs earlier.
		center.delegate = self
		registerCategories()
		center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
	}

	// One category per notification `kind`. Empty for now (no action buttons);
	// Slice 2/3 attach Reconnect / option buttons to error/question.
	private func registerCategories() {
		let categories = ["info", "error", "question"].map {
			UNNotificationCategory(identifier: $0, actions: [], intentIdentifiers: [])
		}
		center.setNotificationCategories(Set(categories))
	}

	func post(_ n: QuayNotification) {
		let content = UNMutableNotificationContent()
		content.title = n.title
		content.body = n.body
		content.categoryIdentifier = n.kind
		content.sound = .default
		// Carry the route through userInfo (JSON-encoded, plist-safe) so the click
		// handler resolves it without re-asking quayd.
		if let route = n.route, let data = try? JSONEncoder().encode(route),
			let json = String(data: data, encoding: .utf8)
		{
			content.userInfo = ["route": json]
		}
		// threadId → request identifier so a re-post under the same thread REPLACES the
		// previous banner (macOS coalesces by identifier); fall back to the unique id.
		let identifier = n.threadId ?? n.id
		let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
		center.add(request) { _ in }
	}

	// Present even when the launcher is frontmost — focus suppression is the
	// launcher's decision, already made before it called `post`.
	func userNotificationCenter(
		_: UNUserNotificationCenter,
		willPresent _: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		completionHandler([.banner, .sound])
	}

	// A click: decode the route from userInfo and hand it to the launcher.
	func userNotificationCenter(
		_: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		var route: QuayNotification.Route?
		if let json = response.notification.request.content.userInfo["route"] as? String,
			let data = json.data(using: .utf8)
		{
			route = try? JSONDecoder().decode(QuayNotification.Route.self, from: data)
		}
		DispatchQueue.main.async { self.onRoute?(route) }
		completionHandler()
	}
}
