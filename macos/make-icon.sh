#!/bin/bash
# Makes Aether.icns from a Nebula screenshot: the middle of the frame in a
# rounded square, at every size macOS asks for.  Usage: make-icon.sh <out.icns>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?usage: make-icon.sh <out.icns>}"
src="$here/../docs/screenshots/nebula.jpg"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/icon.swift" <<'SWIFT'
import AppKit
let args = CommandLine.arguments
guard let img = NSImage(contentsOfFile: args[1]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let side = min(cg.width, cg.height)
let crop = cg.cropping(to: CGRect(x: (cg.width - side) / 2, y: (cg.height - side) / 2, width: side, height: side))!
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    let s = CGFloat(size), inset = s * 0.09, r = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: r.width * 0.225, cornerHeight: r.width * 0.225, transform: nil))
    ctx.clip()
    ctx.draw(crop, in: r)
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(args[2])/\(size).png"))
}
SWIFT

swift "$work/icon.swift" "$src" "$work"
set="$work/Aether.iconset"
mkdir "$set"
for s in 16 32 128 256 512; do
    cp "$work/$s.png" "$set/icon_${s}x${s}.png"
    cp "$work/$((s * 2)).png" "$set/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set" -o "$out"
echo "$out"
