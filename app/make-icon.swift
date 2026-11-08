// Draws Lanes' app icon: three staggered lanes on a graphite tile, like the timeline the app shows.
// Usage: swift make-icon.swift OUT.png   (build.sh turns it into AppIcon.icns)
import AppKit

let size = 1024.0
let out = CommandLine.arguments.dropFirst().first ?? "icon.png"

let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
    // The macOS icon grid: an 824 pt tile with continuous corners, centered, with room for its shadow.
    let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
    let shape = NSBezierPath(roundedRect: tile, xRadius: 186, yRadius: 186)
    NSGraphicsContext.current?.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.shadowBlurRadius = 28
    shadow.shadowOffset = NSSize(width: 0, height: -10)
    shadow.set()
    NSColor(srgbRed: 0.10, green: 0.105, blue: 0.115, alpha: 1).setFill()
    shape.fill()
    NSGraphicsContext.current?.restoreGraphicsState()

    NSGraphicsContext.current?.saveGraphicsState()
    shape.addClip()
    NSGradient(colors: [NSColor(srgbRed: 0.19, green: 0.195, blue: 0.21, alpha: 1),
                        NSColor(srgbRed: 0.075, green: 0.08, blue: 0.09, alpha: 1)])!.draw(in: tile, angle: 90)
    // A hairline of light along the top edge.
    NSColor.white.withAlphaComponent(0.10).setStroke()
    let rim = NSBezierPath(roundedRect: tile.insetBy(dx: 1.5, dy: 1.5), xRadius: 184, yRadius: 184)
    rim.lineWidth = 3
    rim.stroke()

    // Three lanes: blue, orange, aqua, each starting and ending at its own time.
    let lanes: [(CGFloat, CGFloat, CGFloat, NSColor)] = [
        (250, 652, 368, NSColor(srgbRed: 0.224, green: 0.529, blue: 0.898, alpha: 1)),
        (376, 790, 512, NSColor(srgbRed: 0.886, green: 0.396, blue: 0.180, alpha: 1)),
        (300, 560, 656, NSColor(srgbRed: 0.098, green: 0.682, blue: 0.471, alpha: 1)),
    ]
    let thickness: CGFloat = 92
    for (start, end, middle, color) in lanes {
        let rect = NSRect(x: start, y: middle - thickness / 2, width: end - start, height: thickness)
        let bar = NSBezierPath(roundedRect: rect, xRadius: thickness / 2, yRadius: thickness / 2)
        NSGraphicsContext.current?.saveGraphicsState()
        bar.addClip()
        NSGradient(colors: [color.blended(withFraction: 0.18, of: .white)!, color])!.draw(in: rect, angle: 90)
        NSGraphicsContext.current?.restoreGraphicsState()
    }
    NSGraphicsContext.current?.restoreGraphicsState()
    return true
}

guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("could not draw the icon") }
try png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
