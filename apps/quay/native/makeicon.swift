import AppKit

// Render a simple app icon PNG: a rounded square + a letter. Colour is derived
// from the letter so the mocked apps are visually distinguishable.
// usage: makeicon <size> <out.png> [letter]

let args = CommandLine.arguments
let size = Int(args[1]) ?? 512
let out = args[2]
let letter = String((args.count > 3 ? args[3] : "Q").uppercased().prefix(1))

let hue = CGFloat((letter.unicodeScalars.first?.value ?? 81) % 12) / 12.0
let bg = NSColor(calibratedHue: hue, saturation: 0.62, brightness: 0.96, alpha: 1)

let rep = NSBitmapImageRep(
	bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
	bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
	colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let s = CGFloat(size)
bg.setFill()
NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s), xRadius: s * 0.22, yRadius: s * 0.22)
	.fill()
let str = letter as NSString
let attrs: [NSAttributedString.Key: Any] = [
	.font: NSFont.systemFont(ofSize: s * 0.58, weight: .bold),
	.foregroundColor: NSColor.white,
]
let sz = str.size(withAttributes: attrs)
str.draw(at: NSPoint(x: (s - sz.width) / 2, y: (s - sz.height) / 2), withAttributes: attrs)
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: out))
