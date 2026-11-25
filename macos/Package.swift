// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Aether",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Aether",
            path: "Sources/Aether",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("ServiceManagement"),
            ]
        ),
    ]
)
