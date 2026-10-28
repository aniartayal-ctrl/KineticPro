// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SpineForgeMetal",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "SpineForgeMetalCore", targets: ["SpineForgeMetalCore"]),
        .executable(name: "spineforge-metal-cli", targets: ["SpineForgeMetalCLI"]),
        // CANONICAL product: Claude studio in a native Mac window (WKWebView).
        // This is the only binary packaged into Kinetic Pro.app.
        .executable(name: "KineticPro", targets: ["KineticProStudio"])
        // SpineForgeMacApp (SwiftUI Metal prototype) is NOT a product — do not ship it.
    ],
    targets: [
        .target(
            name: "SpineForgeMetalCore",
            path: "Sources/SpineForgeMetalCore",
            linkerSettings: [
                .linkedFramework("Metal"),
                .linkedFramework("MetalKit"),
                .linkedFramework("Vision"),
                .linkedFramework("CoreImage"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
                .linkedFramework("AppKit"),
                .linkedFramework("UniformTypeIdentifiers")
            ]
        ),
        .executableTarget(
            name: "SpineForgeMetalCLI",
            dependencies: ["SpineForgeMetalCore"],
            path: "Sources/SpineForgeMetalCLI"
        ),
        .executableTarget(
            name: "KineticProStudio",
            path: "Sources/KineticProStudio",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit")
            ]
        )
        // Sources/SpineForgeMacApp (SwiftUI Metal prototype) is intentionally
        // excluded — never package it as Kinetic Pro.app.
    ]
)
