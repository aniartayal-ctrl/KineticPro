import Foundation
import simd

public struct SfSpringConfig: Codable, Equatable {
    public var stiffness: Float
    public var damping: Float
    public var gain: [Float]
    public var wind: Float?

    public init(stiffness: Float = 60, damping: Float = 7, gain: [Float] = [6, 3], wind: Float? = 1.2) {
        self.stiffness = stiffness
        self.damping = damping
        self.gain = gain
        self.wind = wind
    }
}

public struct SfFollowConstraint: Codable, Equatable {
    public var bone: String
    public var ratio: Float
}

public struct SfBone: Codable, Equatable, Identifiable {
    public var id: String { name }
    public var name: String
    public var parent: String?
    public var x: Float
    public var y: Float
    public var length: Float?
    public var regions: [[Float]]?
    public var feather: Float?
    public var spring: SfSpringConfig?
    public var follow: SfFollowConstraint?
    public var color: String?

    public init(
        name: String,
        parent: String? = nil,
        x: Float,
        y: Float,
        length: Float? = nil,
        regions: [[Float]]? = nil,
        feather: Float? = nil,
        spring: SfSpringConfig? = nil,
        follow: SfFollowConstraint? = nil,
        color: String? = nil
    ) {
        self.name = name
        self.parent = parent
        self.x = x
        self.y = y
        self.length = length
        self.regions = regions
        self.feather = feather
        self.spring = spring
        self.follow = follow
        self.color = color
    }
}

public struct SfIkConstraint: Codable, Equatable, Identifiable {
    public var id: String { name }
    public var name: String
    public var bones: [String]
    public var target: String
    public var bendPositive: Bool
    public var mix: Float

    public init(name: String, bones: [String], target: String, bendPositive: Bool = true, mix: Float = 1.0) {
        self.name = name
        self.bones = bones
        self.target = target
        self.bendPositive = bendPositive
        self.mix = mix
    }
}

public struct SfPartMesh: Codable, Equatable {
    public var positions: [Float]
    public var uvs: [Float]
    public var joints: [Int]
    public var weights: [Float]
    public var indices: [Int]
    public var hullCount: Int
}

public struct SfSwapRule: Codable, Equatable {
    public var before: String
    public var bone: String
    public var beyond: Float
}

public struct SfPart: Codable, Equatable, Identifiable {
    public var id: String { name }
    public var name: String
    public var src: String
    public var x: Float
    public var y: Float
    public var w: Float
    public var h: Float
    public var bone: String?
    public var skin: [String]?
    public var swap: SfSwapRule?
    public var meshDensity: String?
    public var mesh: SfPartMesh?

    public init(
        name: String,
        src: String,
        x: Float,
        y: Float,
        w: Float,
        h: Float,
        bone: String? = nil,
        skin: [String]? = nil,
        swap: SfSwapRule? = nil,
        meshDensity: String? = nil,
        mesh: SfPartMesh? = nil
    ) {
        self.name = name
        self.src = src
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.bone = bone
        self.skin = skin
        self.swap = swap
        self.meshDensity = meshDensity
        self.mesh = mesh
    }
}

public struct SfTransformKey: Codable, Equatable {
    public var time: Float
    public var r: Float?
    public var x: Float?
    public var y: Float?
    public var sx: Float?
    public var sy: Float?

    public init(time: Float, r: Float? = nil, x: Float? = nil, y: Float? = nil, sx: Float? = nil, sy: Float? = nil) {
        self.time = time
        self.r = r
        self.x = x
        self.y = y
        self.sx = sx
        self.sy = sy
    }
}

public struct SfFxKey: Codable, Equatable {
    public var time: Float
    public var flash: Float?
    public var shake: Float?
    public var keyPose: Float?
}

public struct SfAnimationClip: Codable, Equatable {
    public var name: String
    public var duration: Float
    public var fps: Float
    public var loop: Bool
    public var boneTracks: [String: [SfTransformKey]]
    public var fxTrack: [SfFxKey]?
}

public struct SfFrameMargin: Codable, Equatable {
    public var left: Float
    public var top: Float
    public var right: Float
    public var bottom: Float?

    public init(left: Float, top: Float, right: Float, bottom: Float? = nil) {
        self.left = left
        self.top = top
        self.right = right
        self.bottom = bottom
    }
}

public struct SfPalette: Codable, Equatable {
    public var rim: String
    public var flash: String

    public init(rim: String, flash: String) {
        self.rim = rim
        self.flash = flash
    }
}

public struct SfKeyPose: Codable, Equatable {
    public var src: String
    public var x: Float
    public var y: Float
    public var w: Float
    public var h: Float
}

public struct SfProject: Codable, Equatable {
    public var version: String
    public var id: String
    public var title: String
    public var src: String
    public var width: Int
    public var height: Int
    public var action: String
    public var frame: SfFrameMargin
    public var palette: SfPalette
    public var bones: [SfBone]
    public var ikConstraints: [SfIkConstraint]
    public var parts: [SfPart]
    public var keyPose: SfKeyPose?
    public var animations: [String: SfAnimationClip]

    public init(
        version: String,
        id: String,
        title: String,
        src: String,
        width: Int,
        height: Int,
        action: String,
        frame: SfFrameMargin,
        palette: SfPalette,
        bones: [SfBone],
        ikConstraints: [SfIkConstraint],
        parts: [SfPart],
        keyPose: SfKeyPose? = nil,
        animations: [String: SfAnimationClip]
    ) {
        self.version = version
        self.id = id
        self.title = title
        self.src = src
        self.width = width
        self.height = height
        self.action = action
        self.frame = frame
        self.palette = palette
        self.bones = bones
        self.ikConstraints = ikConstraints
        self.parts = parts
        self.keyPose = keyPose
        self.animations = animations
    }
}

// GPU Buffer Structs matching SpineForgeMetalShaders.mslSource
public struct GpuRigVertex {
    public var position: SIMD2<Float>
    public var deform: SIMD2<Float>
    public var uv: SIMD2<Float>
    public var joints: SIMD4<UInt32>
    public var weights: SIMD4<Float>
    public var heat: SIMD4<Float>

    public init(
        position: SIMD2<Float>,
        deform: SIMD2<Float> = .zero,
        uv: SIMD2<Float>,
        joints: SIMD4<UInt32>,
        weights: SIMD4<Float>,
        heat: SIMD4<Float>
    ) {
        self.position = position
        self.deform = deform
        self.uv = uv
        self.joints = joints
        self.weights = weights
        self.heat = heat
    }
}

public struct GpuBoneMatrix2D {
    public var col01: SIMD4<Float> // [a, b, c, d]
    public var trans: SIMD4<Float> // [tx, ty, 0, 0]

    public init(a: Float = 1, b: Float = 0, c: Float = 0, d: Float = 1, tx: Float = 0, ty: Float = 0) {
        self.col01 = SIMD4<Float>(a, b, c, d)
        self.trans = SIMD4<Float>(tx, ty, 0, 0)
    }
}

public struct GpuViewUniforms {
    public var viewTransform: SIMD4<Float>
    public var rimColor: SIMD3<Float>
    public var flashIntensity: Float
    public var flashTint: SIMD3<Float>
    public var heatmapMix: Float
    public var texelSize: SIMD2<Float>
    public var partOpacity: Float
    public var rimAmount: Float

    public init(
        viewTransform: SIMD4<Float>,
        rimColor: SIMD3<Float>,
        flashIntensity: Float,
        flashTint: SIMD3<Float>,
        heatmapMix: Float,
        texelSize: SIMD2<Float>,
        partOpacity: Float,
        rimAmount: Float
    ) {
        self.viewTransform = viewTransform
        self.rimColor = rimColor
        self.flashIntensity = flashIntensity
        self.flashTint = flashTint
        self.heatmapMix = heatmapMix
        self.texelSize = texelSize
        self.partOpacity = partOpacity
        self.rimAmount = rimAmount
    }
}

public struct GpuGizmoVertex {
    public var position: SIMD2<Float>
    public var color: SIMD4<Float>

    public init(position: SIMD2<Float>, color: SIMD4<Float>) {
        self.position = position
        self.color = color
    }
}

public struct GpuCapsule {
    public var a: SIMD2<Float>
    public var b: SIMD2<Float>
    public var radius: Float
    public var feather: Float
    public var boneIndex: UInt32
    public var padding: UInt32 = 0

    public init(a: SIMD2<Float>, b: SIMD2<Float>, radius: Float, feather: Float, boneIndex: UInt32) {
        self.a = a
        self.b = b
        self.radius = radius
        self.feather = feather
        self.boneIndex = boneIndex
    }
}

public struct GpuWeightComputeParams {
    public var vertexCount: UInt32
    public var capsuleCount: UInt32
    public var fallbackBoneIndex: UInt32
    public var mode: UInt32
}
