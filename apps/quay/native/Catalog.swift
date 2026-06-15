import Foundation

// One app in the launcher catalog — matches quayd's AppInfo ({id, name, glyph}).
struct CatalogApp: Decodable {
	let id: String
	let name: String
	let glyph: String
}

// The launcher's Swift ws client for quayd's privileged JSON channel. It discovers the
// daemon (Quayd.ensure, off the main thread), opens ws://127.0.0.1:PORT/?token=…, asks
// for the catalog ({type:'list'} → {type:'catalog'}), and reconnects on drop. `onCatalog`
// fires on the main thread for every catalog frame — including the daemon's post-install
// broadcast — so the native results list stays live. This replaces launcher.js's socket;
// the chat webview owns its own agent socket separately.
final class CatalogClient {
	var onCatalog: (([CatalogApp]) -> Void)?
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
		c.path = "/"
		c.queryItems = [URLQueryItem(name: "token", value: runtime.token)]
		let t = session.webSocketTask(with: c.url!)
		task = t
		t.resume()
		onRuntime?(runtime.port, runtime.token)
		send(["type": "list"])
		receive()
	}

	private func send(_ payload: [String: Any]) {
		guard let data = try? JSONSerialization.data(withJSONObject: payload),
			let text = String(data: data, encoding: .utf8)
		else { return }
		task?.send(.string(text)) { _ in }
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
		case "catalog":
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
