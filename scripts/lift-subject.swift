import AppKit
import Vision

// macOS's own subject lifting — the same thing Preview does when you drag a
// cut-out out of a photo. Better than any threshold we could write by hand.
let args = CommandLine.arguments
guard args.count == 3,
      let source = CIImage(contentsOf: URL(fileURLWithPath: args[1]))
else { fatalError("usage: lift <in.png> <out.png>") }

let handler = VNImageRequestHandler(ciImage: source)
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])

guard let result = request.results?.first else { fatalError("no subject found") }
let masked = try result.generateMaskedImage(
  ofInstances: result.allInstances,
  from: handler,
  croppedToInstancesExtent: true,
)

let image = CIImage(cvPixelBuffer: masked)
let context = CIContext()
guard let colour = CGColorSpace(name: CGColorSpace.sRGB) else { fatalError("no colour space") }
try context.writePNGRepresentation(
  of: image,
  to: URL(fileURLWithPath: args[2]),
  format: .RGBA8,
  colorSpace: colour,
)
print("cut out \(Int(image.extent.width))×\(Int(image.extent.height))")
