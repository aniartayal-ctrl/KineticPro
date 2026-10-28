import Foundation
import Metal
import MetalKit
import CoreGraphics
import ImageIO
import AppKit
import UniformTypeIdentifiers
import simd

public struct MetalPartState {
    public var name: String
    public var vertexBuffer: MTLBuffer
    public var indexBuffer: MTLBuffer
    public var indexCount: Int
    public var vertexCount: Int
    public var texture: MTLTexture
    public var texelSize: SIMD2<Float>
    public var vertices: [GpuRigVertex]
    public var indices: [UInt16]
}

public final class MetalRigRenderer {
    public let device: MTLDevice
    public let commandQueue: MTLCommandQueue
    public let skinPipeline: MTLRenderPipelineState
    public let gizmoPipeline: MTLRenderPipelineState
    public let weightComputePipeline: MTLComputePipelineState
    public let samplerState: MTLSamplerState

    public var solver: SpineForgeSkeletonSolver
    public var parts: [String: MetalPartState] = [:]
    public var publicRootURL: URL

    public static let bonePaletteHex: [String] = [
        "#64748b", "#ef4444", "#22c55e", "#3b82f6",
        "#eab308", "#ec4899", "#06b6d4", "#f97316",
        "#a855f7", "#84cc16", "#14b8a6", "#f43f5e"
    ]

    public init(project: SfProject, publicRootURL: URL) throws {
        guard let dev = MetalMaxPerformance.bestDevice() else {
            throw NSError(domain: "SpineForgeMetal", code: 1, userInfo: [NSLocalizedDescriptionKey: "No Apple Metal GPU device found"])
        }
        guard let queue = MetalMaxPerformance.makeMaxCommandQueue(on: dev) else {
            throw NSError(domain: "SpineForgeMetal", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create Metal command queue"])
        }
        self.device = dev
        self.commandQueue = queue
        self.solver = SpineForgeSkeletonSolver(project: project)
        self.publicRootURL = publicRootURL

        let library = try dev.makeLibrary(source: SpineForgeMetalShaders.mslSource, options: nil)
        guard let vSkin = library.makeFunction(name: "vertex_skin_2d"),
              let fRig = library.makeFunction(name: "fragment_rig_2d"),
              let vGizmo = library.makeFunction(name: "vertex_gizmo_2d"),
              let fGizmo = library.makeFunction(name: "fragment_gizmo_2d"),
              let kWeights = library.makeFunction(name: "compute_auto_weights") else {
            throw NSError(domain: "SpineForgeMetal", code: 3, userInfo: [NSLocalizedDescriptionKey: "Missing shader functions in Metal library"])
        }

        // 1. Skinning Render Pipeline
        let skinDesc = MTLRenderPipelineDescriptor()
        skinDesc.vertexFunction = vSkin
        skinDesc.fragmentFunction = fRig
        let vDesc = MTLVertexDescriptor()
        // position: float2
        vDesc.attributes[0].format = .float2
        vDesc.attributes[0].offset = MemoryLayout<GpuRigVertex>.offset(of: \.position)!
        vDesc.attributes[0].bufferIndex = 0
        // deform: float2
        vDesc.attributes[1].format = .float2
        vDesc.attributes[1].offset = MemoryLayout<GpuRigVertex>.offset(of: \.deform)!
        vDesc.attributes[1].bufferIndex = 0
        // uv: float2
        vDesc.attributes[2].format = .float2
        vDesc.attributes[2].offset = MemoryLayout<GpuRigVertex>.offset(of: \.uv)!
        vDesc.attributes[2].bufferIndex = 0
        // joints: uint4
        vDesc.attributes[3].format = .uint4
        vDesc.attributes[3].offset = MemoryLayout<GpuRigVertex>.offset(of: \.joints)!
        vDesc.attributes[3].bufferIndex = 0
        // weights: float4
        vDesc.attributes[4].format = .float4
        vDesc.attributes[4].offset = MemoryLayout<GpuRigVertex>.offset(of: \.weights)!
        vDesc.attributes[4].bufferIndex = 0
        // heat: float4
        vDesc.attributes[5].format = .float4
        vDesc.attributes[5].offset = MemoryLayout<GpuRigVertex>.offset(of: \.heat)!
        vDesc.attributes[5].bufferIndex = 0

        vDesc.layouts[0].stride = MemoryLayout<GpuRigVertex>.stride
        skinDesc.vertexDescriptor = vDesc

        skinDesc.colorAttachments[0].pixelFormat = .bgra8Unorm
        skinDesc.colorAttachments[0].isBlendingEnabled = true
        skinDesc.colorAttachments[0].rgbBlendOperation = .add
        skinDesc.colorAttachments[0].alphaBlendOperation = .add
        skinDesc.colorAttachments[0].sourceRGBBlendFactor = .one
        skinDesc.colorAttachments[0].sourceAlphaBlendFactor = .one
        skinDesc.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        skinDesc.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha

        self.skinPipeline = try dev.makeRenderPipelineState(descriptor: skinDesc)

        // 2. Gizmo Render Pipeline
        let gizmoDesc = MTLRenderPipelineDescriptor()
        gizmoDesc.vertexFunction = vGizmo
        gizmoDesc.fragmentFunction = fGizmo
        let gDesc = MTLVertexDescriptor()
        gDesc.attributes[0].format = .float2
        gDesc.attributes[0].offset = MemoryLayout<GpuGizmoVertex>.offset(of: \.position)!
        gDesc.attributes[0].bufferIndex = 0
        gDesc.attributes[1].format = .float4
        gDesc.attributes[1].offset = MemoryLayout<GpuGizmoVertex>.offset(of: \.color)!
        gDesc.attributes[1].bufferIndex = 0
        gDesc.layouts[0].stride = MemoryLayout<GpuGizmoVertex>.stride
        gizmoDesc.vertexDescriptor = gDesc
        gizmoDesc.colorAttachments[0].pixelFormat = .bgra8Unorm
        gizmoDesc.colorAttachments[0].isBlendingEnabled = true
        gizmoDesc.colorAttachments[0].sourceRGBBlendFactor = .one
        gizmoDesc.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        gizmoDesc.colorAttachments[0].sourceAlphaBlendFactor = .one
        gizmoDesc.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        self.gizmoPipeline = try dev.makeRenderPipelineState(descriptor: gizmoDesc)

        // 3. GPU Compute Pipeline for Auto-Weighting
        self.weightComputePipeline = try dev.makeComputePipelineState(function: kWeights)

        let sampDesc = MTLSamplerDescriptor()
        sampDesc.minFilter = .linear
        sampDesc.magFilter = .linear
        sampDesc.sAddressMode = .clampToEdge
        sampDesc.tAddressMode = .clampToEdge
        self.samplerState = dev.makeSamplerState(descriptor: sampDesc)!

        try rebuildAllParts()
    }

    public func loadProject(_ newProject: SfProject, publicRoot: URL? = nil) throws {
        if let root = publicRoot {
            self.publicRootURL = root
        }
        self.solver = SpineForgeSkeletonSolver(project: newProject)
        try rebuildAllParts()
    }

    public func rebuildAllParts() throws {
        parts.removeAll()
        let project = solver.project
        let rigW = Float(project.width)
        let rigH = Float(project.height)

        for part in project.parts {
            let tex = loadTexture(for: part)
            let (verts, inds) = buildPartVerticesAndIndices(part: part, rigW: rigW, rigH: rigH)
            guard !verts.isEmpty, !inds.isEmpty else { continue }

            let vBuf = device.makeBuffer(
                bytes: verts,
                length: verts.count * MemoryLayout<GpuRigVertex>.stride,
                options: .storageModeShared
            )!
            let iBuf = device.makeBuffer(
                bytes: inds,
                length: inds.count * MemoryLayout<UInt16>.stride,
                options: .storageModeShared
            )!

            var state = MetalPartState(
                name: part.name,
                vertexBuffer: vBuf,
                indexBuffer: iBuf,
                indexCount: inds.count,
                vertexCount: verts.count,
                texture: tex,
                texelSize: SIMD2<Float>(1.0 / Float(max(1, tex.width)), 1.0 / Float(max(1, tex.height))),
                vertices: verts,
                indices: inds
            )

            // If mesh didn't have precomputed weights, dispatch Metal Compute Shader to solve weights on GPU!
            if part.mesh == nil && (part.skin?.count ?? 0) > 1 {
                computeWeightsOnGPU(for: &state, part: part, mode: 0)
            }
            updateHeatmapColors(for: &state, selectedBoneIndex: -1)
            parts[part.name] = state
        }
    }

    /// Executes the `compute_auto_weights` Metal Compute Kernel on the Apple Silicon GPU!
    public func computeWeightsOnGPU(for state: inout MetalPartState, part: SfPart, mode: UInt32 = 0) {
        let project = solver.project
        let rigW = Float(project.width)
        let rigH = Float(project.height)
        let skinNames = part.skin ?? [part.bone ?? "root"]
        let fallbackIdx = UInt32(solver.boneIndex[skinNames.first ?? "root"] ?? 0)

        var capsules: [GpuCapsule] = []
        for boneName in skinNames.dropFirst() {
            guard let bIdx = solver.boneIndex[boneName] else { continue }
            let bone = project.bones[bIdx]
            let feather = (bone.feather ?? 0.05) * rigH
            if let regs = bone.regions, !regs.isEmpty {
                for reg in regs where reg.count >= 5 {
                    capsules.append(GpuCapsule(
                        a: SIMD2<Float>(reg[0] * rigW, reg[1] * rigH),
                        b: SIMD2<Float>(reg[2] * rigW, reg[3] * rigH),
                        radius: reg[4] * rigH,
                        feather: feather,
                        boneIndex: UInt32(bIdx)
                    ))
                }
            } else {
                let a = SIMD2<Float>(bone.x * rigW, bone.y * rigH)
                var b = a
                if let childIdx = solver.parents.firstIndex(of: bIdx) {
                    let cb = project.bones[childIdx]
                    b = SIMD2<Float>(cb.x * rigW, cb.y * rigH)
                }
                capsules.append(GpuCapsule(
                    a: a,
                    b: b,
                    radius: (bone.length ?? 0.08) * rigH,
                    feather: feather * 1.4,
                    boneIndex: UInt32(bIdx)
                ))
            }
        }

        if capsules.isEmpty {
            capsules.append(GpuCapsule(a: .zero, b: .zero, radius: 1, feather: 1, boneIndex: fallbackIdx))
        }

        let vCount = state.vertexCount
        let positions: [SIMD2<Float>] = state.vertices.map { $0.position }

        guard let posBuf = device.makeBuffer(bytes: positions, length: vCount * MemoryLayout<SIMD2<Float>>.stride, options: .storageModeShared),
              let capBuf = device.makeBuffer(bytes: capsules, length: capsules.count * MemoryLayout<GpuCapsule>.stride, options: .storageModeShared),
              let outJBuf = device.makeBuffer(length: vCount * MemoryLayout<SIMD4<UInt32>>.stride, options: .storageModeShared),
              let outWBuf = device.makeBuffer(length: vCount * MemoryLayout<SIMD4<Float>>.stride, options: .storageModeShared),
              let cmdBuf = commandQueue.makeCommandBuffer(),
              let enc = cmdBuf.makeComputeCommandEncoder() else { return }

        var params = GpuWeightComputeParams(
            vertexCount: UInt32(vCount),
            capsuleCount: UInt32(capsules.count),
            fallbackBoneIndex: fallbackIdx,
            mode: mode
        )

        enc.setComputePipelineState(weightComputePipeline)
        enc.setBuffer(posBuf, offset: 0, index: 0)
        enc.setBuffer(capBuf, offset: 0, index: 1)
        enc.setBytes(&params, length: MemoryLayout<GpuWeightComputeParams>.stride, index: 2)
        enc.setBuffer(outJBuf, offset: 0, index: 3)
        enc.setBuffer(outWBuf, offset: 0, index: 4)

        let w = weightComputePipeline.threadExecutionWidth
        let threadsPerGroup = MTLSize(width: w, height: 1, depth: 1)
        let threadgroups = MTLSize(width: (vCount + w - 1) / w, height: 1, depth: 1)
        enc.dispatchThreadgroups(threadgroups, threadsPerThreadgroup: threadsPerGroup)
        enc.endEncoding()
        cmdBuf.commit()
        cmdBuf.waitUntilCompleted()

        let jPtr = outJBuf.contents().bindMemory(to: SIMD4<UInt32>.self, capacity: vCount)
        let wPtr = outWBuf.contents().bindMemory(to: SIMD4<Float>.self, capacity: vCount)
        for v in 0..<vCount {
            state.vertices[v].joints = jPtr[v]
            state.vertices[v].weights = wPtr[v]
        }
        syncVertexBuffer(for: &state)
    }

    public func paintWeightStroke(
        partName: String,
        rigPoint: SIMD2<Float>,
        radius: Float,
        strength: Float,
        boneIndex: Int,
        mode: String,
        selectedBoneForHeatmap: Int
    ) {
        guard var state = parts[partName] else { return }
        let r = max(1.0, radius)
        let targetB = UInt32(max(0, boneIndex))

        for v in 0..<state.vertexCount {
            let pos = state.vertices[v].position
            let dist = simd_distance(pos, rigPoint)
            guard dist <= r else { continue }
            let u = max(0, min(1, dist / r))
            let falloff = 1.0 - (u * u * (3.0 - 2.0 * u))
            let amount = max(0, min(1, strength * falloff))
            guard amount > 1e-4 else { continue }

            var j = state.vertices[v].joints
            var w = state.vertices[v].weights

            // Find if targetB is already in top 4
            var slot = -1
            for k in 0..<4 {
                if j[k] == targetB {
                    slot = k
                    break
                }
            }
            if slot < 0 {
                // Replace smallest weight slot
                var minK = 0
                for k in 1..<4 {
                    if w[k] < w[minK] { minK = k }
                }
                slot = minK
                j[slot] = targetB
                w[slot] = 0
            }

            let cur = w[slot]
            var next = cur
            if mode == "subtract" {
                next = max(0, cur - amount)
            } else if mode == "replace" {
                next = cur * (1.0 - amount) + amount
            } else {
                next = min(1.0, cur + amount)
            }
            w[slot] = next

            var otherSum: Float = 0
            for k in 0..<4 where k != slot {
                otherSum += w[k]
            }
            let rem = max(0, 1.0 - next)
            if otherSum > 1e-6 {
                let scale = rem / otherSum
                for k in 0..<4 where k != slot {
                    w[k] *= scale
                }
            } else if rem > 0 {
                let fallbackSlot = (slot + 1) % 4
                w[fallbackSlot] += rem
            }

            state.vertices[v].joints = j
            state.vertices[v].weights = w
        }

        updateHeatmapColors(for: &state, selectedBoneIndex: selectedBoneForHeatmap)
        syncVertexBuffer(for: &state)
        parts[partName] = state
    }

    public func updateAllHeatmaps(selectedBoneIndex: Int) {
        for key in parts.keys {
            if var st = parts[key] {
                updateHeatmapColors(for: &st, selectedBoneIndex: selectedBoneIndex)
                syncVertexBuffer(for: &st)
                parts[key] = st
            }
        }
    }

    public func regeneratePartMeshOnMetal(
        partName: String,
        density: String,
        weightMode: UInt32,
        selectedBoneForHeatmap: Int
    ) {
        guard let pIdx = solver.project.parts.firstIndex(where: { $0.name == partName }),
              var oldState = parts[partName] else { return }
        var part = solver.project.parts[pIdx]
        part.meshDensity = density
        let generated = MetalMeshAndClipsGenerator.generatePartMesh(
            part: part,
            projectWidth: solver.project.width,
            projectHeight: solver.project.height,
            density: density
        )
        part.mesh = generated
        solver.project.parts[pIdx] = part

        let rigW = Float(solver.project.width)
        let rigH = Float(solver.project.height)
        let (verts, inds) = buildPartVerticesAndIndices(part: part, rigW: rigW, rigH: rigH)
        guard !verts.isEmpty, !inds.isEmpty else { return }

        oldState.vertices = verts
        oldState.indices = inds
        oldState.vertexCount = verts.count
        oldState.indexCount = inds.count
        oldState.vertexBuffer = device.makeBuffer(
            bytes: verts,
            length: verts.count * MemoryLayout<GpuRigVertex>.stride,
            options: .storageModeShared
        )!
        oldState.indexBuffer = device.makeBuffer(
            bytes: inds,
            length: inds.count * MemoryLayout<UInt16>.stride,
            options: .storageModeShared
        )!

        if (part.skin?.count ?? 0) > 1 {
            computeWeightsOnGPU(for: &oldState, part: part, mode: weightMode)
        }
        updateHeatmapColors(for: &oldState, selectedBoneIndex: selectedBoneForHeatmap)
        syncVertexBuffer(for: &oldState)
        parts[partName] = oldState
    }

    private func updateHeatmapColors(for state: inout MetalPartState, selectedBoneIndex: Int) {
        let bones = solver.project.bones
        let boneColors: [SIMD3<Float>] = bones.enumerated().map { (idx, b) in
            Self.hexToRgb(b.color ?? Self.bonePaletteHex[idx % Self.bonePaletteHex.count])
        }

        for v in 0..<state.vertexCount {
            let j = state.vertices[v].joints
            let w = state.vertices[v].weights
            if selectedBoneIndex >= 0 {
                var bw: Float = 0
                for k in 0..<4 {
                    if Int(j[k]) == selectedBoneIndex { bw += w[k] }
                }
                bw = max(0, min(1, bw))
                let r = max(0, min(1, 1.5 - abs(4.0 * bw - 3.0)))
                let g = max(0, min(1, 1.5 - abs(4.0 * bw - 2.0)))
                let b = max(0, min(1, 1.5 - abs(4.0 * bw - 1.0)))
                state.vertices[v].heat = SIMD4<Float>(r, g, b, 0.25 + 0.68 * bw)
            } else {
                var col = SIMD3<Float>.zero
                for k in 0..<4 {
                    let bIdx = Int(j[k])
                    let bc = (bIdx >= 0 && bIdx < boneColors.count) ? boneColors[bIdx] : SIMD3<Float>(0.5, 0.5, 0.5)
                    col += bc * w[k]
                }
                state.vertices[v].heat = SIMD4<Float>(col.x, col.y, col.z, 0.75)
            }
        }
    }

    private func syncVertexBuffer(for state: inout MetalPartState) {
        let ptr = state.vertexBuffer.contents().bindMemory(to: GpuRigVertex.self, capacity: state.vertexCount)
        for i in 0..<state.vertexCount {
            ptr[i] = state.vertices[i]
        }
    }

    private func buildPartVerticesAndIndices(part: SfPart, rigW: Float, rigH: Float) -> ([GpuRigVertex], [UInt16]) {
        if let m = part.mesh, m.positions.count >= 8 {
            let vCount = m.positions.count / 2
            var verts: [GpuRigVertex] = []
            verts.reserveCapacity(vCount)
            for v in 0..<vCount {
                let pos = SIMD2<Float>(m.positions[v * 2], m.positions[v * 2 + 1])
                let uv = SIMD2<Float>(m.uvs[v * 2], m.uvs[v * 2 + 1])
                let j = SIMD4<UInt32>(
                    UInt32(max(0, m.joints[v * 4])),
                    UInt32(max(0, m.joints[v * 4 + 1])),
                    UInt32(max(0, m.joints[v * 4 + 2])),
                    UInt32(max(0, m.joints[v * 4 + 3]))
                )
                let w = SIMD4<Float>(
                    m.weights[v * 4],
                    m.weights[v * 4 + 1],
                    m.weights[v * 4 + 2],
                    m.weights[v * 4 + 3]
                )
                verts.append(GpuRigVertex(position: pos, uv: uv, joints: j, weights: w, heat: SIMD4<Float>(0, 0.8, 1, 0.7)))
            }
            let inds = m.indices.map { UInt16($0) }
            return (verts, inds)
        }

        // Synthesize subdivided grid mesh on the fly if part.mesh is omitted
        let isRigid = (part.skin == nil || part.skin!.isEmpty) && part.bone != nil
        let cols = isRigid ? 1 : max(2, Int(round(28.0 * part.w)))
        let rows = isRigid ? 1 : max(2, Int(round(Float(cols) * (part.h * rigH) / max(1.0, part.w * rigW))))
        let left = part.x * rigW
        let top = part.y * rigH
        let width = part.w * rigW
        let height = part.h * rigH
        let boneIdx = UInt32(solver.boneIndex[part.bone ?? part.skin?.first ?? "root"] ?? 0)

        var verts: [GpuRigVertex] = []
        for r in 0...rows {
            let v = Float(r) / Float(rows)
            for c in 0...cols {
                let u = Float(c) / Float(cols)
                let pos = SIMD2<Float>(left + u * width, top + v * height)
                verts.append(GpuRigVertex(
                    position: pos,
                    uv: SIMD2<Float>(u, v),
                    joints: SIMD4<UInt32>(boneIdx, 0, 0, 0),
                    weights: SIMD4<Float>(1, 0, 0, 0),
                    heat: SIMD4<Float>(0.2, 0.7, 1.0, 0.7)
                ))
            }
        }

        var inds: [UInt16] = []
        for r in 0..<rows {
            for c in 0..<cols {
                let a = UInt16(r * (cols + 1) + c)
                let b = a + 1
                let c0 = a + UInt16(cols + 1)
                let d = c0 + 1
                inds.append(contentsOf: [a, c0, b, b, c0, d])
            }
        }
        return (verts, inds)
    }

    private func loadTexture(for part: SfPart) -> MTLTexture {
        let relPath = part.src.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let fileURL = publicRootURL.appendingPathComponent(relPath)

        if let nsImg = NSImage(contentsOf: fileURL),
           let cgImg = nsImg.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            let w = cgImg.width
            let h = cgImg.height
            var rawData = [UInt8](repeating: 0, count: w * h * 4)
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            if let ctx = CGContext(
                data: &rawData,
                width: w,
                height: h,
                bitsPerComponent: 8,
                bytesPerRow: w * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) {
                ctx.draw(cgImg, in: CGRect(x: 0, y: 0, width: w, height: h))
                // Unpremultiply so fragment shader can apply clean rim/flash before premultiplying
                for i in 0..<(w * h) {
                    let a = rawData[i * 4 + 3]
                    if a > 0 && a < 255 {
                        let af = Float(a) / 255.0
                        rawData[i * 4] = UInt8(min(255.0, Float(rawData[i * 4]) / af))
                        rawData[i * 4 + 1] = UInt8(min(255.0, Float(rawData[i * 4 + 1]) / af))
                        rawData[i * 4 + 2] = UInt8(min(255.0, Float(rawData[i * 4 + 2]) / af))
                    }
                }
                let desc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: w, height: h, mipmapped: false)
                desc.usage = [.shaderRead]
                if let tex = device.makeTexture(descriptor: desc) {
                    tex.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: rawData, bytesPerRow: w * 4)
                    return tex
                }
            }
        }

        // Fallback 16x16 texture if file not found
        let desc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 16, height: 16, mipmapped: false)
        let tex = device.makeTexture(descriptor: desc)!
        let fill = [UInt8](repeating: 200, count: 16 * 16 * 4)
        tex.replace(region: MTLRegionMake2D(0, 0, 16, 16), mipmapLevel: 0, withBytes: fill, bytesPerRow: 16 * 4)
        return tex
    }

    public func computeViewMetrics(viewportWidth: Float, viewportHeight: Float) -> (scale: Float, offsetX: Float, offsetY: Float, viewVec: SIMD4<Float>) {
        let project = solver.project
        let artW = Float(project.width)
        let artH = Float(project.height)
        let leftM = project.frame.left
        let rightM = project.frame.right
        let topM = project.frame.top
        let bottomM = project.frame.bottom ?? 0.05

        let spanW = artW * (1.0 + leftM + rightM)
        let spanH = artH * (1.0 + topM + bottomM)
        let scale = min(viewportWidth / spanW, viewportHeight / spanH)
        let offsetX = (viewportWidth - spanW * scale) * 0.5 + leftM * artW * scale
        let offsetY = (viewportHeight - spanH * scale) * 0.5 + topM * artH * scale

        let vx = (2.0 * scale) / viewportWidth
        let vy = (-2.0 * scale) / viewportHeight
        let vz = (2.0 * offsetX) / viewportWidth - 1.0
        let vw = 1.0 - (2.0 * offsetY) / viewportHeight
        return (scale, offsetX, offsetY, SIMD4<Float>(vx, vy, vz, vw))
    }

    public func encodeFrame(
        into encoder: MTLRenderCommandEncoder,
        viewportSize: SIMD2<Float>,
        drawOrder: [String],
        flash: Float,
        heatmapMix: Float = 0,
        selectedPart: String? = nil,
        isolatePart: Bool = false,
        showWireframe: Bool = false,
        showBones: Bool = false,
        selectedBone: String? = nil,
        brushCursor: (pos: SIMD2<Float>, radius: Float)? = nil
    ) {
        let metrics = computeViewMetrics(viewportWidth: viewportSize.x, viewportHeight: viewportSize.y)
        let rimRgb = Self.hexToRgb(solver.project.palette.rim)
        let flashRgb = Self.hexToRgb(solver.project.palette.flash)

        encoder.setRenderPipelineState(skinPipeline)
        encoder.setFragmentSamplerState(samplerState, index: 0)
        encoder.setVertexBytes(
            solver.gpuBones,
            length: min(64, solver.gpuBones.count) * MemoryLayout<GpuBoneMatrix2D>.stride,
            index: 1
        )

        for partName in drawOrder {
            guard let state = parts[partName] else { continue }
            let opacity: Float = (isolatePart && selectedPart != nil && selectedPart != partName) ? 0.18 : 1.0
            let heat: Float = (heatmapMix > 0 && (selectedPart == nil || selectedPart == partName)) ? heatmapMix : 0.0

            var uniforms = GpuViewUniforms(
                viewTransform: metrics.viewVec,
                rimColor: rimRgb,
                flashIntensity: flash,
                flashTint: flashRgb,
                heatmapMix: heat,
                texelSize: state.texelSize,
                partOpacity: opacity,
                rimAmount: 0.0
            )

            encoder.setVertexBuffer(state.vertexBuffer, offset: 0, index: 0)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<GpuViewUniforms>.stride, index: 2)
            encoder.setFragmentBytes(&uniforms, length: MemoryLayout<GpuViewUniforms>.stride, index: 2)
            encoder.setFragmentTexture(state.texture, index: 0)

            encoder.drawIndexedPrimitives(
                type: .triangle,
                indexCount: state.indexCount,
                indexType: .uint16,
                indexBuffer: state.indexBuffer,
                indexBufferOffset: 0
            )
        }

        // Hardware Metal Gizmo Pass (Delaunay Wireframe, Skeleton Bones, IK Handles, Brush Ring)
        if showWireframe || showBones || brushCursor != nil {
            var gizmoLines: [GpuGizmoVertex] = []
            var gizmoPoints: [GpuGizmoVertex] = []

            func deformCPU(_ v: GpuRigVertex) -> SIMD2<Float> {
                let p = v.position + v.deform
                var out = SIMD2<Float>.zero
                for k in 0..<4 {
                    let w = v.weights[k]
                    if w <= 1e-5 { continue }
                    let bIdx = Int(v.joints[k])
                    let bm = solver.gpuBones[bIdx]
                    let m = bm.col01
                    let t = bm.trans
                    let sp = SIMD2<Float>(m.x * p.x + m.z * p.y + t.x, m.y * p.x + m.w * p.y + t.y)
                    out += sp * w
                }
                return out
            }

            if showWireframe {
                for partName in drawOrder {
                    if isolatePart, let selP = selectedPart, selP != partName { continue }
                    guard let state = parts[partName] else { continue }
                    let isSel = (selectedPart == partName)
                    let lineCol = isSel ? SIMD4<Float>(0.22, 0.74, 0.97, 0.62) : SIMD4<Float>(0.58, 0.64, 0.72, 0.22)
                    let deformed = state.vertices.map { deformCPU($0) }
                    let triCount = state.indices.count / 3
                    for t in 0..<triCount {
                        let p0 = deformed[Int(state.indices[t * 3])]
                        let p1 = deformed[Int(state.indices[t * 3 + 1])]
                        let p2 = deformed[Int(state.indices[t * 3 + 2])]
                        gizmoLines.append(GpuGizmoVertex(position: p0, color: lineCol))
                        gizmoLines.append(GpuGizmoVertex(position: p1, color: lineCol))
                        gizmoLines.append(GpuGizmoVertex(position: p1, color: lineCol))
                        gizmoLines.append(GpuGizmoVertex(position: p2, color: lineCol))
                        gizmoLines.append(GpuGizmoVertex(position: p2, color: lineCol))
                        gizmoLines.append(GpuGizmoVertex(position: p0, color: lineCol))
                    }
                }
            }

            if showBones {
                for (i, bone) in solver.project.bones.enumerated() {
                    let wMat = solver.world[i]
                    let bPos = SIMD2<Float>(wMat.tx, wMat.ty)
                    let isSel = (bone.name == selectedBone)
                    let rgb = Self.hexToRgb(bone.color ?? Self.bonePaletteHex[i % Self.bonePaletteHex.count])
                    let col = isSel ? SIMD4<Float>(1, 1, 1, 1) : SIMD4<Float>(rgb.x, rgb.y, rgb.z, 0.95)

                    let pIdx = solver.parents[i]
                    if pIdx >= 0 && !bone.name.hasPrefix("ik-") {
                        let pMat = solver.world[pIdx]
                        let pPos = SIMD2<Float>(pMat.tx, pMat.ty)
                        gizmoLines.append(GpuGizmoVertex(position: pPos, color: col))
                        gizmoLines.append(GpuGizmoVertex(position: bPos, color: col))
                    }

                    // Draw diamond around pivot
                    let r: Float = isSel ? 9.0 : 6.0
                    let d0 = bPos + SIMD2<Float>(0, -r)
                    let d1 = bPos + SIMD2<Float>(r, 0)
                    let d2 = bPos + SIMD2<Float>(0, r)
                    let d3 = bPos + SIMD2<Float>(-r, 0)
                    gizmoLines.append(contentsOf: [
                        GpuGizmoVertex(position: d0, color: col), GpuGizmoVertex(position: d1, color: col),
                        GpuGizmoVertex(position: d1, color: col), GpuGizmoVertex(position: d2, color: col),
                        GpuGizmoVertex(position: d2, color: col), GpuGizmoVertex(position: d3, color: col),
                        GpuGizmoVertex(position: d3, color: col), GpuGizmoVertex(position: d0, color: col)
                    ])
                    gizmoPoints.append(GpuGizmoVertex(position: bPos, color: col))
                }
            }

            if let cursor = brushCursor {
                let segs = 36
                let ringCol = SIMD4<Float>(0.13, 0.85, 0.45, 0.95)
                for s in 0..<segs {
                    let a0 = Float(s) * 2.0 * .pi / Float(segs)
                    let a1 = Float(s + 1) * 2.0 * .pi / Float(segs)
                    let p0 = cursor.pos + SIMD2<Float>(cos(a0), sin(a0)) * cursor.radius
                    let p1 = cursor.pos + SIMD2<Float>(cos(a1), sin(a1)) * cursor.radius
                    gizmoLines.append(GpuGizmoVertex(position: p0, color: ringCol))
                    gizmoLines.append(GpuGizmoVertex(position: p1, color: ringCol))
                }
            }

            encoder.setRenderPipelineState(gizmoPipeline)
            var uniforms = GpuViewUniforms(
                viewTransform: metrics.viewVec,
                rimColor: .zero,
                flashIntensity: 0,
                flashTint: .zero,
                heatmapMix: 0,
                texelSize: .zero,
                partOpacity: 1,
                rimAmount: 0
            )
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<GpuViewUniforms>.stride, index: 1)

            if !gizmoLines.isEmpty,
               let lineBuf = device.makeBuffer(bytes: gizmoLines, length: gizmoLines.count * MemoryLayout<GpuGizmoVertex>.stride, options: .storageModeShared) {
                encoder.setVertexBuffer(lineBuf, offset: 0, index: 0)
                encoder.drawPrimitives(type: .line, vertexStart: 0, vertexCount: gizmoLines.count)
            }
            if !gizmoPoints.isEmpty,
               let ptBuf = device.makeBuffer(bytes: gizmoPoints, length: gizmoPoints.count * MemoryLayout<GpuGizmoVertex>.stride, options: .storageModeShared) {
                encoder.setVertexBuffer(ptBuf, offset: 0, index: 0)
                encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: gizmoPoints.count)
            }
        }
    }

    /// Bakes an entire multi-clip flipbook sprite sheet on the Apple Silicon Metal GPU in milliseconds!
    public func bakeSpriteSheetOnMetalGPU(
        cellHeight: Int = 220,
        columns: Int = 8,
        fps: Float = 12.0,
        clipNames: [String]? = nil,
        outputPNGURL: URL
    ) throws -> (sheetWidth: Int, sheetHeight: Int, totalFrames: Int, elapsedMs: Double) {
        let startTime = CFAbsoluteTimeGetCurrent()
        let project = solver.project
        let spanW = Float(project.width) * (1.0 + project.frame.left + project.frame.right)
        let spanH = Float(project.height) * (1.0 + project.frame.top + (project.frame.bottom ?? 0.05))
        let cellWidth = max(32, Int(round(Float(cellHeight) * spanW / spanH)))

        let clipsOrder = clipNames ?? project.animations.keys.sorted()
        var frameSchedule: [(clip: String, time: Float, dt: Float)] = []

        for clipName in clipsOrder {
            guard let clip = project.animations[clipName] else { continue }
            let count = max(4, Int(round(clip.duration * fps)))
            let dt = clip.duration / Float(count)
            for i in 0..<count {
                frameSchedule.append((clipName, Float(i) * dt, dt))
            }
        }

        let totalFrames = max(1, frameSchedule.count)
        let rows = max(1, (totalFrames + columns - 1) / columns)
        let sheetWidth = columns * cellWidth
        let sheetHeight = rows * cellHeight

        let texDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm,
            width: sheetWidth,
            height: sheetHeight,
            mipmapped: false
        )
        texDesc.usage = [.renderTarget, .shaderRead]
        texDesc.storageMode = .shared
        guard let targetTex = device.makeTexture(descriptor: texDesc),
              let cmdBuf = commandQueue.makeCommandBuffer() else {
            throw NSError(domain: "SpineForgeMetal", code: 4, userInfo: [NSLocalizedDescriptionKey: "Failed to allocate Metal sheet texture"])
        }

        let passDesc = MTLRenderPassDescriptor()
        passDesc.colorAttachments[0].texture = targetTex
        passDesc.colorAttachments[0].loadAction = .clear
        passDesc.colorAttachments[0].storeAction = .store
        passDesc.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)

        guard let enc = cmdBuf.makeRenderCommandEncoder(descriptor: passDesc) else {
            throw NSError(domain: "SpineForgeMetal", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to create Metal render encoder"])
        }

        var lastClip = ""
        for (idx, item) in frameSchedule.enumerated() {
            if item.clip != lastClip {
                solver.resetSprings()
                lastClip = item.clip
            }
            let col = idx % columns
            let row = idx / columns
            let vpX = Double(col * cellWidth)
            let vpY = Double(row * cellHeight)

            enc.setViewport(MTLViewport(
                originX: vpX,
                originY: vpY,
                width: Double(cellWidth),
                height: Double(cellHeight),
                znear: 0.0,
                zfar: 1.0
            ))

            let eval = solver.evaluateClip(name: item.clip, at: item.time, dt: item.dt)
            encodeFrame(
                into: enc,
                viewportSize: SIMD2<Float>(Float(cellWidth), Float(cellHeight)),
                drawOrder: eval.drawOrder,
                flash: eval.flash
            )
        }

        enc.endEncoding()
        cmdBuf.commit()
        cmdBuf.waitUntilCompleted()

        try Self.writeTextureToPNG(texture: targetTex, url: outputPNGURL)
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000.0
        return (sheetWidth, sheetHeight, totalFrames, elapsedMs)
    }

    /// Renders a single high-resolution preview/verification frame on Apple Metal GPU and writes it to PNG.
    public func renderSingleFrameOnMetalGPU(
        clipName: String,
        time: Float,
        width: Int = 900,
        height: Int = 1100,
        showWireframe: Bool = false,
        showBones: Bool = false,
        heatmapMix: Float = 0,
        outputPNGURL: URL
    ) throws {
        let texDesc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        texDesc.usage = [.renderTarget, .shaderRead]
        texDesc.storageMode = .shared
        let tex = device.makeTexture(descriptor: texDesc)!

        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = tex
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0.035, green: 0.05, blue: 0.086, alpha: 1.0)

        let cmd = commandQueue.makeCommandBuffer()!
        let enc = cmd.makeRenderCommandEncoder(descriptor: pass)!
        enc.setViewport(MTLViewport(originX: 0, originY: 0, width: Double(width), height: Double(height), znear: 0, zfar: 1))

        solver.resetSprings()
        let eval = solver.evaluateClip(name: clipName, at: time, dt: 1.0 / 60.0)
        encodeFrame(
            into: enc,
            viewportSize: SIMD2<Float>(Float(width), Float(height)),
            drawOrder: eval.drawOrder,
            flash: eval.flash,
            heatmapMix: heatmapMix,
            showWireframe: showWireframe,
            showBones: showBones
        )
        enc.endEncoding()
        cmd.commit()
        cmd.waitUntilCompleted()

        try Self.writeTextureToPNG(texture: tex, url: outputPNGURL)
    }

    public static func writeTextureToPNG(texture: MTLTexture, url: URL) throws {
        let w = texture.width
        let h = texture.height
        let bytesPerRow = w * 4
        var bgra = [UInt8](repeating: 0, count: w * h * 4)
        texture.getBytes(&bgra, bytesPerRow: bytesPerRow, from: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0)

        // Swizzle BGRA -> RGBA for CGImage
        for i in 0..<(w * h) {
            let b = bgra[i * 4]
            let r = bgra[i * 4 + 2]
            bgra[i * 4] = r
            bgra[i * 4 + 2] = b
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let provider = CGDataProvider(data: Data(bgra) as CFData),
              let cgImage = CGImage(
                  width: w,
                  height: h,
                  bitsPerComponent: 8,
                  bitsPerPixel: 32,
                  bytesPerRow: bytesPerRow,
                  space: colorSpace,
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                  provider: provider,
                  decode: nil,
                  shouldInterpolate: true,
                  intent: .defaultIntent
              ),
              let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw NSError(domain: "SpineForgeMetal", code: 6, userInfo: [NSLocalizedDescriptionKey: "Failed to encode PNG to \(url.path)"])
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        if !CGImageDestinationFinalize(dest) {
            throw NSError(domain: "SpineForgeMetal", code: 7, userInfo: [NSLocalizedDescriptionKey: "Failed to finalize PNG write"])
        }
    }

    public static func hexToRgb(_ hex: String) -> SIMD3<Float> {
        let clean = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let val = UInt32(clean.prefix(6), radix: 16) ?? 0xffffff
        return SIMD3<Float>(
            Float((val >> 16) & 0xff) / 255.0,
            Float((val >> 8) & 0xff) / 255.0,
            Float(val & 0xff) / 255.0
        )
    }
}
