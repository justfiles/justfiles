// swift-tools-version:5.9
import PackageDescription

// Two executables, Command Line Tools only (no Xcodeproj). `swift build` discovers
// the sources under Sources/ — so there's no hand-maintained file list — and links
// the launcher's UserNotifications framework declaratively. build.sh stamps the
// .app bundles around the binaries this produces; quayd materialises per-app
// bundles from the same quay-shell binary (see quayd/materialize.ts).
let package = Package(
	name: "quay",
	platforms: [.macOS(.v12)],
	targets: [
		.executableTarget(
			name: "quay-shell",
			linkerSettings: [.linkedFramework("UserNotifications")]
		),
		.executableTarget(name: "quay-makeicon"),
	],
	swiftLanguageVersions: [.v5]
)
