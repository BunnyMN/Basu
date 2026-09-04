// swift-tools-version: 6.0
import PackageDescription

// Shared by the app and the widget extension: tokens, the activity attributes,
// the order snapshot both read, and the one raster tile. It imports nothing
// from the app — the dependency runs one way.
let package = Package(
  name: "BasuKit",
  platforms: [.iOS(.v18)],
  products: [.library(name: "BasuKit", targets: ["BasuKit"])],
  targets: [
    .target(
      name: "BasuKit",
      resources: [.process("Resources")],
      swiftSettings: [.enableUpcomingFeature("StrictConcurrency")],
    ),
    .testTarget(name: "BasuKitTests", dependencies: ["BasuKit"]),
  ],
)
