import Cocoa

// One binary, two modes. Mode is decided by configuration:
//   • an AppId (Info.plist / env / --app) ⟹ booter  — one mini-app window.
//   • otherwise (or --launcher)              ⟹ launcher — the agent + hotkey panel.
// The launcher bundle ships without AppId; each mini-app bundle ships with one.

struct Config {
	let appId: String?
	let appName: String
	let targetURL: URL?

	static func resolve() -> Config {
		let args = CommandLine.arguments
		let env = ProcessInfo.processInfo.environment
		let info = Bundle.main.infoDictionary ?? [:]

		func arg(_ name: String) -> String? {
			guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
			return args[i + 1]
		}

		let raw = args.contains("--launcher")
			? nil
			: (arg("--app") ?? env["FRIEREN_APP_ID"] ?? info["AppId"] as? String)
		let id = (raw?.isEmpty == false) ? raw : nil

		let urlStr = arg("--url") ?? env["FRIEREN_TARGET_URL"] ?? (info["TargetURL"] as? String)
		let name = (info["CFBundleName"] as? String) ?? id?.capitalized ?? "Just Computer"
		return Config(appId: id, appName: name, targetURL: urlStr.flatMap { URL(string: $0) })
	}
}

let config = Config.resolve()
let app = NSApplication.shared

// Retained for the process lifetime (NSApplication.delegate is weak).
let delegate: NSApplicationDelegate
if let appId = config.appId {
	app.setActivationPolicy(.regular) // real foreground app: Dock icon + menu
	delegate = BooterDelegate(appId: appId, name: config.appName, target: config.targetURL)
} else {
	app.setActivationPolicy(.accessory) // LSUIElement: no Dock icon
	delegate = LauncherDelegate()
}
app.delegate = delegate
app.run()
