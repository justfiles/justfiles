import Foundation

// One app in the launcher catalog. The daemon's /system frame carries app manifests
// ({id, name, …}); we decode the two fields the springboard needs and derive the fallback
// glyph. The grid prefers the materialised .app icon (see Grid.swift), so the glyph only
// shows before a bundle exists.
struct CatalogApp: Decodable {
	let id: String
	let name: String
	var glyph: String { (name.first ?? id.first).map { String($0).uppercased() } ?? "?" }
}

// One slash command for the composer's `/` menu — matches quayd's CommandMeta
// ({name, description, kind}); `kind` is ignored natively (the daemon dispatches it).
struct CatalogCommand: Decodable {
	let name: String
	let description: String
}

// The launcher's Swift ws client for the daemon's catalog channel. It discovers the daemon
// (Quayd.ensure, off the main thread), opens ws://127.0.0.1:PORT/system, and reconnects on
// drop. The daemon pushes the catalog frame ({type:'apps', apps}) on connect (and re-pushes
// on catalog changes), so there is no request to send. `onCatalog` fires on the main thread
// for every frame, keeping the native springboard live. The chat webview owns its own agent
// socket (the daemon's /agent RPC) separately.
//
// Commands (the `/` menu) and notifications are not yet on /system — they ride their own
// daemon-parity items; `onCommands`/`onNotification` stay wired so they light up for free
// once the daemon emits those frames.
final class CatalogClient {
	var onCatalog: (([CatalogApp]) -> Void)?
	// Fires (main thread) with the slash-command catalogue (built-ins + skills),
	// fetched once per connect — the composer renders its `/` menu from it.
	var onCommands: (([CatalogCommand]) -> Void)?
	// Fires (main thread) with the live {port, token} every time the socket opens — the
	// single discovery path the launcher trusts. The chat webview rides it too: a quayd
	// restart drops this socket, reconnects on a fresh runtime, and re-fires, so the
	// launcher reloads the (otherwise stale-port) transcript webview without its own probe.
	var onRuntime: ((Int, String) -> Void)?
	// Fires (main thread) for each `notify`-capability notification quayd broadcasts.
	// The launcher decides focus suppression and projects it onto the OS banner.
	var onNotification: ((QuayNotification) -> Void)?

	private var task: URLSessionWebSocketTask?
	private var opening = false
	private let session = URLSession(configuration: .default)

	// Ensure a live connection; a no-op if one is open or already being opened. Safe to
	// call repeatedly (e.g. on every panel summon) — the guards collapse it to one socket.
	func connect() {
		if task != nil || opening { return }
		opening = true
		DispatchQueue.global().async { [weak self] in
			let runtime = Quayd.ensure()
			DispatchQueue.main.async {
				guard let self else { return }
				self.opening = false
				guard let runtime else { return self.retry() }
				self.open(runtime)
			}
		}
	}

	private func open(_ runtime: Quayd.Runtime) {
		var c = URLComponents()
		c.scheme = "ws"
		c.host = "127.0.0.1"
		c.port = runtime.port
		c.path = "/system"
		// The daemon doesn't enforce the token yet; we still carry it so discovery and the
		// privileged channel converge once it does.
		c.queryItems = [URLQueryItem(name: "token", value: runtime.token)]
		let t = session.webSocketTask(with: c.url!)
		task = t
		t.resume()
		onRuntime?(runtime.port, runtime.token)
		// No request to send: /system pushes the catalog ({type:'apps'}) on open.
		receive()
	}

	private func receive() {
		task?.receive { [weak self] result in
			guard let self else { return }
			switch result {
			case .failure:
				DispatchQueue.main.async { self.dropped() }
			case .success(let message):
				if case .string(let text) = message { self.handle(text) }
				self.receive()
			}
		}
	}

	private func handle(_ text: String) {
		guard let data = text.data(using: .utf8),
			let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return }
		switch obj["type"] as? String {
		case "apps":
			// The daemon's catalog frame: app manifests, decoded down to {id, name}.
			guard let appsRaw = try? JSONSerialization.data(withJSONObject: obj["apps"] ?? []),
				let apps = try? JSONDecoder().decode([CatalogApp].self, from: appsRaw)
			else { return }
			DispatchQueue.main.async { self.onCatalog?(apps) }
		case "notification":
			guard let raw = obj["notification"],
				let nData = try? JSONSerialization.data(withJSONObject: raw),
				let n = try? JSONDecoder().decode(QuayNotification.self, from: nData)
			else { return }
			DispatchQueue.main.async { self.onNotification?(n) }
		default:
			return
		}
	}

	private func dropped() {
		task = nil
		retry()
	}

	private func retry() {
		DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.connect() }
	}
}
