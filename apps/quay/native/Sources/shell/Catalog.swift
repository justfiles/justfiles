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

// One slash command for the composer's `/` menu — matches the daemon's CommandMeta
// ({name, description, kind}); `kind` is ignored natively (the daemon dispatches it).
struct CatalogCommand: Decodable {
	let name: String
	let description: String
}

// What the daemon says to do after dispatching a command (its CommandResult). `nil` is a
// fire-and-forget command (nothing to show — the launcher dismisses).
enum CommandResult {
	case chat  // reveal the chat surface (a `/new` or a skill turn; the transcript updates live)
	case text(String)  // show a one-off text panel (e.g. `/debug`)
}

// The launcher's Swift ws client for the daemon's catalog channel. It discovers the daemon
// (Daemon.ensure, off the main thread), opens ws://127.0.0.1:PORT/system, and reconnects on
// drop. The daemon pushes the catalog frame ({type:'apps', apps}) on connect (and re-pushes
// on catalog changes), so there is no request to send. `onCatalog` fires on the main thread
// for every frame, keeping the native springboard live. The chat webview owns its own agent
// socket (the daemon's /agent RPC) separately.
//
// Slash commands ride /system (a `commands` frame on connect); notifications ride it too.
// `onCommands`/`onNotification` fire on the main thread as those frames arrive.
final class CatalogClient {
	var onCatalog: (([CatalogApp]) -> Void)?
	// Fires (main thread) with the slash-command catalogue (built-ins + skills),
	// fetched once per connect — the composer renders its `/` menu from it.
	var onCommands: (([CatalogCommand]) -> Void)?
	// Fires (main thread) with the live {port, token} every time the socket opens — the
	// single discovery path the launcher trusts. The chat webview rides it too: a daemon
	// restart drops this socket, reconnects on a fresh runtime, and re-fires, so the
	// launcher reloads the (otherwise stale-port) transcript webview without its own probe.
	var onRuntime: ((Int, String) -> Void)?
	// Fires (main thread) for each `notify`-capability notification daemon broadcasts.
	// The launcher decides focus suppression and projects it onto the OS banner.
	var onNotification: ((NotifyMessage) -> Void)?

	private var task: URLSessionWebSocketTask?
	private var opening = false
	private let session = URLSession(configuration: .default)
	// In-flight command dispatches keyed by request id; the reply frame resolves them.
	// Touched only on the main thread (runCommand is called from the UI; replies hop to main).
	private var pendingCommands: [String: (CommandResult?) -> Void] = [:]

	// Dispatch a slash command over the /system socket (commands are a daemon concept, not
	// the agent's): send `{command, id, name}` and resolve `completion` with the daemon's
	// CommandResult when the matching reply lands. No socket → nothing to do.
	func runCommand(_ name: String, completion: @escaping (CommandResult?) -> Void) {
		guard let task else { return }
		let id = UUID().uuidString
		pendingCommands[id] = completion
		let payload: [String: Any] = ["type": "command", "id": id, "name": name]
		guard let data = try? JSONSerialization.data(withJSONObject: payload),
			let text = String(data: data, encoding: .utf8)
		else { return }
		task.send(.string(text)) { _ in }
	}

	// Ensure a live connection; a no-op if one is open or already being opened. Safe to
	// call repeatedly (e.g. on every panel summon) — the guards collapse it to one socket.
	func connect() {
		if task != nil || opening { return }
		opening = true
		DispatchQueue.global().async { [weak self] in
			let runtime = Daemon.ensure()
			DispatchQueue.main.async {
				guard let self else { return }
				self.opening = false
				guard let runtime else { return self.retry() }
				self.open(runtime)
			}
		}
	}

	private func open(_ runtime: Daemon.Runtime) {
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
		case "commands":
			// The slash-command catalogue for the composer's `/` menu.
			guard let raw = try? JSONSerialization.data(withJSONObject: obj["commands"] ?? []),
				let commands = try? JSONDecoder().decode([CatalogCommand].self, from: raw)
			else { return }
			DispatchQueue.main.async { self.onCommands?(commands) }
		case "commandResult":
			// Reply to a dispatched command: resolve its pending completion (on main).
			guard let id = obj["id"] as? String else { return }
			let result = Self.decodeCommandResult(obj["result"])
			DispatchQueue.main.async { self.pendingCommands.removeValue(forKey: id)?(result) }
		case "notification":
			guard let raw = obj["notification"],
				let nData = try? JSONSerialization.data(withJSONObject: raw),
				let n = try? JSONDecoder().decode(NotifyMessage.self, from: nData)
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

	// Decode the daemon's CommandResult ({show:'chat'} | {show:'text',body} | null).
	private static func decodeCommandResult(_ raw: Any?) -> CommandResult? {
		guard let obj = raw as? [String: Any] else { return nil }
		switch obj["show"] as? String {
		case "chat": return .chat
		case "text": return .text(obj["body"] as? String ?? "")
		default: return nil
		}
	}

	private func retry() {
		DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.connect() }
	}
}
