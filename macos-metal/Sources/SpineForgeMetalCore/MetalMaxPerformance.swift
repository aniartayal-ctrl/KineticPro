import Foundation
import Metal
import AppKit

/// Runs Kinetic Pro at the highest GPU + unified-memory quota the Mac exposes.
public enum MetalMaxPerformance {
    /// Prefer the Metal device with the largest recommended working set (discrete GPU when present).
    public static func bestDevice() -> MTLDevice? {
        let devices = MTLCopyAllDevices()
        if devices.isEmpty {
            return MTLCreateSystemDefaultDevice()
        }
        return devices.max(by: { a, b in
            if a.recommendedMaxWorkingSetSize != b.recommendedMaxWorkingSetSize {
                return a.recommendedMaxWorkingSetSize < b.recommendedMaxWorkingSetSize
            }
            // Prefer low-power=false (high-performance) when working sets tie.
            return a.isLowPower && !b.isLowPower
        })
    }

    /// Deepest practical command-buffer ring so the GPU stays fully fed.
    public static func makeMaxCommandQueue(on device: MTLDevice) -> MTLCommandQueue? {
        // Metal allows up to 2048; 256 keeps the GPU saturated without runaway latency.
        device.makeCommandQueue(maxCommandBufferCount: 256)
            ?? device.makeCommandQueue()
    }

    /// Display’s maximum refresh (ProMotion 120 when available).
    public static func maximumFramesPerSecond(for screen: NSScreen? = NSScreen.main) -> Int {
        let hz = screen?.maximumFramesPerSecond ?? 60
        return max(60, hz)
    }

    /// Keep the process at interactive priority so App Nap / throttling don’t starve Metal.
    public static func beginProcessBoost() -> NSObjectProtocol {
        ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical],
            reason: "Kinetic Pro Apple Metal studio — maximum GPU & memory quota"
        )
    }

    public static func endProcessBoost(_ token: NSObjectProtocol?) {
        guard let token else { return }
        ProcessInfo.processInfo.endActivity(token)
    }

    public struct Quota: Equatable {
        public var deviceName: String
        public var unifiedMemory: Bool
        public var recommendedWorkingSetMB: Int
        public var allocatedMB: Int
        public var systemMemoryMB: Int
        public var workingSetPercent: Int
        public var maxFPS: Int

        public var statusLine: String {
            "\(deviceName) · GPU mem \(allocatedMB)/\(recommendedWorkingSetMB) MB (\(workingSetPercent)%) · RAM \(systemMemoryMB) MB · \(maxFPS)Hz max"
        }
    }

    public static func quota(for device: MTLDevice, screen: NSScreen? = NSScreen.main) -> Quota {
        let recommended = max(1, Int(device.recommendedMaxWorkingSetSize / (1024 * 1024)))
        let allocated = Int(device.currentAllocatedSize / (1024 * 1024))
        let system = Int(ProcessInfo.processInfo.physicalMemory / (1024 * 1024))
        let pct = min(100, (allocated * 100) / recommended)
        return Quota(
            deviceName: device.name,
            unifiedMemory: device.hasUnifiedMemory,
            recommendedWorkingSetMB: recommended,
            allocatedMB: allocated,
            systemMemoryMB: system,
            workingSetPercent: pct,
            maxFPS: maximumFramesPerSecond(for: screen)
        )
    }
}
