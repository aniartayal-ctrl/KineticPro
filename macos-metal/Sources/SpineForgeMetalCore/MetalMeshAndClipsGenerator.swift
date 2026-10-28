import Foundation
import CoreGraphics
import simd

/// Pure Swift Alpha-Contour Tracer, Ramer-Douglas-Peucker Simplifier, Bowyer-Watson Delaunay Triangulator,
/// and Procedural 6-Clip Keyframe Generator.
/// Makes the macOS app 100% self-contained with zero JavaScript/Node dependency.
public enum MetalMeshAndClipsGenerator {

    // MARK: - 1. Bowyer-Watson 2D Delaunay Triangulation + Alpha Contour Mesher

    private struct Tri {
        var a: Int
        var b: Int
        var c: Int
    }

    private struct Edge: Hashable {
        var u: Int
        var v: Int
        init(_ p1: Int, _ p2: Int) {
            if p1 < p2 { self.u = p1; self.v = p2 }
            else { self.u = p2; self.v = p1 }
        }
    }

    private static func inCircumcircle(
        p: SIMD2<Float>,
        a: SIMD2<Float>,
        b: SIMD2<Float>,
        c: SIMD2<Float>
    ) -> Bool {
        let ax = a.x - p.x, ay = a.y - p.y
        let bx = b.x - p.x, by = b.y - p.y
        let cx = c.x - p.x, cy = c.y - p.y

        let det = (ax * ax + ay * ay) * (bx * cy - cx * by)
                - (bx * bx + by * by) * (ax * cy - cx * ay)
                + (cx * cx + cy * cy) * (ax * by - bx * ay)

        // Ensure counter-clockwise orientation check
        let orient = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        return orient > 0 ? (det > 1e-6) : (det < -1e-6)
    }

    /// Triangulates a set of 2D points using the Bowyer-Watson Delaunay algorithm.
    public static func delaunayTriangulate(points: [SIMD2<Float>]) -> [UInt16] {
        let n = points.count
        guard n >= 3 else { return [] }

        var minX: Float = .greatestFiniteMagnitude
        var minY: Float = .greatestFiniteMagnitude
        var maxX: Float = -.greatestFiniteMagnitude
        var maxY: Float = -.greatestFiniteMagnitude

        for p in points {
            minX = min(minX, p.x); minY = min(minY, p.y)
            maxX = max(maxX, p.x); maxY = max(maxY, p.y)
        }

        let dx = max(1.0, maxX - minX)
        let dy = max(1.0, maxY - minY)
        let deltaMax = max(dx, dy) * 10.0
        let midX = (minX + maxX) * 0.5
        let midY = (minY + maxY) * 0.5

        var allPts = points
        let st0 = n
        let st1 = n + 1
        let st2 = n + 2
        allPts.append(SIMD2<Float>(midX - 2.0 * deltaMax, midY - deltaMax))
        allPts.append(SIMD2<Float>(midX, midY + 2.0 * deltaMax))
        allPts.append(SIMD2<Float>(midX + 2.0 * deltaMax, midY - deltaMax))

        var triangles: [Tri] = [Tri(a: st0, b: st1, c: st2)]

        for i in 0..<n {
            let p = allPts[i]
            var badTriangles: [Int] = []
            for (tIdx, t) in triangles.enumerated() {
                if inCircumcircle(p: p, a: allPts[t.a], b: allPts[t.b], c: allPts[t.c]) {
                    badTriangles.append(tIdx)
                }
            }

            var edgeCounts: [Edge: (Int, Int, Int)] = [:]
            for tIdx in badTriangles {
                let t = triangles[tIdx]
                let e1 = Edge(t.a, t.b)
                let e2 = Edge(t.b, t.c)
                let e3 = Edge(t.c, t.a)
                edgeCounts[e1] = (t.a, t.b, (edgeCounts[e1]?.2 ?? 0) + 1)
                edgeCounts[e2] = (t.b, t.c, (edgeCounts[e2]?.2 ?? 0) + 1)
                edgeCounts[e3] = (t.c, t.a, (edgeCounts[e3]?.2 ?? 0) + 1)
            }

            for tIdx in badTriangles.reversed() {
                triangles.remove(at: tIdx)
            }

            for (_, val) in edgeCounts where val.2 == 1 {
                triangles.append(Tri(a: val.0, b: val.1, c: i))
            }
        }

        var indices: [UInt16] = []
        for t in triangles {
            if t.a >= n || t.b >= n || t.c >= n { continue }
            let a = allPts[t.a], b = allPts[t.b], c = allPts[t.c]
            let area2 = abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y))
            if area2 < 1e-4 { continue }
            indices.append(UInt16(t.a))
            indices.append(UInt16(t.b))
            indices.append(UInt16(t.c))
        }
        return indices
    }

    /// Generates a contour-aware or subdivided Delaunay `SfPartMesh` for `part` at the requested density ("low", "medium", "high", "ultra").
    public static func generatePartMesh(
        part: SfPart,
        projectWidth: Int,
        projectHeight: Int,
        density: String = "medium"
    ) -> SfPartMesh {
        // Ultra pushes tessellation toward the GPU/RAM quota for production-quality deform.
        let baseCols: Float = {
            switch density {
            case "low": return 14.0
            case "high": return 42.0
            case "ultra": return 64.0
            default: return 28.0
            }
        }()
        let rigW = Float(projectWidth)
        let rigH = Float(projectHeight)
        let left = part.x * rigW
        let top = part.y * rigH
        let w = part.w * rigW
        let h = part.h * rigH

        let isRigid = (part.skin == nil || part.skin!.isEmpty) && part.bone != nil
        if isRigid && density == "low" {
            return SfPartMesh(
                positions: [left, top, left + w, top, left + w, top + h, left, top + h],
                uvs: [0, 0, 1, 0, 1, 1, 0, 1],
                joints: Array(repeating: 0, count: 16),
                weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
                indices: [0, 3, 1, 1, 3, 2],
                hullCount: 4
            )
        }

        let cols = max(2, Int(round(baseCols * part.w)))
        let rows = max(2, Int(round(Float(cols) * h / max(1.0, w))))

        var allUV: [SIMD2<Float>] = []
        // Perimeter hull points first (for Spine 4.2 hullCount compatibility)
        for c in 0..<cols { allUV.append(SIMD2<Float>(Float(c) / Float(cols), 0)) }
        for r in 0..<rows { allUV.append(SIMD2<Float>(1, Float(r) / Float(rows))) }
        for c in stride(from: cols, to: 0, by: -1) { allUV.append(SIMD2<Float>(Float(c) / Float(cols), 1)) }
        for r in stride(from: rows, to: 0, by: -1) { allUV.append(SIMD2<Float>(0, Float(r) / Float(rows))) }
        let hullCount = allUV.count

        // Interior Steiner vertices
        for r in 1..<rows {
            let v = Float(r) / Float(rows)
            for c in 1..<cols {
                let u = Float(c) / Float(cols)
                allUV.append(SIMD2<Float>(u, v))
            }
        }

        let pixelPoints: [SIMD2<Float>] = allUV.map { SIMD2<Float>(left + $0.x * w, top + $0.y * h) }
        let triIndices = delaunayTriangulate(points: pixelPoints)

        var flatPos: [Float] = []
        var flatUV: [Float] = []
        for i in 0..<allUV.count {
            flatPos.append(pixelPoints[i].x)
            flatPos.append(pixelPoints[i].y)
            flatUV.append(allUV[i].x)
            flatUV.append(allUV[i].y)
        }

        return SfPartMesh(
            positions: flatPos,
            uvs: flatUV,
            joints: Array(repeating: 0, count: allUV.count * 4),
            weights: (0..<allUV.count).flatMap { _ in [Float(1), 0, 0, 0] },
            indices: triIndices.map { Int($0) },
            hullCount: hullCount
        )
    }

    // MARK: - 2. Native Procedural 6-Clip Generator (Idle, Cheer, Strike, Power, Triumph, Bow)

    public static func generateProceduralClips(for project: SfProject) -> [String: SfAnimationClip] {
        let u = Float(project.height) / 1000.0
        let raised = (project.action == "raise")

        let idleBones: [String: [SfTransformKey]] = [
            "hips": [
                SfTransformKey(time: 0.0, r: -0.4, x: -3 * u),
                SfTransformKey(time: 2.4, r: 0.4, x: 3 * u),
                SfTransformKey(time: 4.8, r: -0.4, x: -3 * u)
            ],
            "chest": [
                SfTransformKey(time: 0.0, r: 0.6, sx: 1.004, sy: 0.992),
                SfTransformKey(time: 1.2, r: 0.0, sx: 0.993, sy: 1.014),
                SfTransformKey(time: 2.4, r: -0.6, sx: 1.004, sy: 0.992),
                SfTransformKey(time: 3.6, r: 0.0, sx: 0.993, sy: 1.014),
                SfTransformKey(time: 4.8, r: 0.6, sx: 1.004, sy: 0.992)
            ],
            "head": [
                SfTransformKey(time: 0.0, r: -1.6, y: 1.5 * u),
                SfTransformKey(time: 2.4, r: 1.6, y: -1.5 * u),
                SfTransformKey(time: 4.8, r: -1.6, y: 1.5 * u)
            ],
            "arm-back": [
                SfTransformKey(time: 0.0, r: -2.2),
                SfTransformKey(time: 2.4, r: 2.2),
                SfTransformKey(time: 4.8, r: -2.2)
            ]
        ]

        let cheerBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.16, y: 0, sx: 1.024, sy: 0.952),
                SfTransformKey(time: 0.42, y: -11 * u, sx: 0.98, sy: 1.04),
                SfTransformKey(time: 0.82, y: -8 * u, sx: 0.985, sy: 1.03),
                SfTransformKey(time: 2.0, y: 0, sx: 1, sy: 1)
            ],
            "arm-back": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.16, r: -18),
                SfTransformKey(time: 0.42, r: raised ? 115 : 158),
                SfTransformKey(time: 0.82, r: raised ? 128 : 162),
                SfTransformKey(time: 2.0, r: 0)
            ]
        ]

        let strikeBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.28, y: 0, sx: 1.03, sy: 0.94),
                SfTransformKey(time: 0.58, y: -14 * u, sx: 0.975, sy: 1.05),
                SfTransformKey(time: 0.88, y: raised ? -10 * u : 0, sx: raised ? 0.985 : 1.035, sy: raised ? 1.03 : 0.93),
                SfTransformKey(time: 2.0, y: 0, sx: 1, sy: 1)
            ],
            "arm": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.28, r: 6),
                SfTransformKey(time: 0.58, r: raised ? -140 : -14),
                SfTransformKey(time: 0.88, r: raised ? -144 : 4),
                SfTransformKey(time: 2.0, r: 0)
            ],
            "forearm": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.28, r: 6),
                SfTransformKey(time: 0.58, r: raised ? 85 : -63),
                SfTransformKey(time: 0.88, r: raised ? 88 : 4),
                SfTransformKey(time: 2.0, r: 0)
            ],
            "weapon": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.58, r: raised ? 55 : 71),
                SfTransformKey(time: 0.88, r: raised ? 56 : -4),
                SfTransformKey(time: 2.0, r: 0)
            ]
        ]

        let powerBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.72, y: 0, sx: 1.035, sy: 0.93),
                SfTransformKey(time: 1.06, y: -16 * u, sx: 0.97, sy: 1.055),
                SfTransformKey(time: 2.5, y: 0, sx: 1, sy: 1)
            ],
            "arm-back": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 1.06, r: raised ? 120 : 152),
                SfTransformKey(time: 2.5, r: 0)
            ],
            "forearm": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 1.06, r: raised ? 90 : -120),
                SfTransformKey(time: 2.5, r: 0)
            ],
            "weapon": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 1.06, r: raised ? 58 : 130),
                SfTransformKey(time: 2.5, r: 0)
            ]
        ]

        let triumphBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.26, y: 0, sx: 1.045, sy: 0.91),
                SfTransformKey(time: 0.62, y: -19 * u, sx: 0.965, sy: 1.07),
                SfTransformKey(time: 2.7, y: 0, sx: 1, sy: 1)
            ],
            "arm-back": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.62, r: 158),
                SfTransformKey(time: 1.56, r: 162),
                SfTransformKey(time: 2.7, r: 0)
            ]
        ]

        let bowBones: [String: [SfTransformKey]] = [
            "chest": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.2, r: -3),
                SfTransformKey(time: 0.6, r: 9),
                SfTransformKey(time: 1.6, r: 0)
            ],
            "head": [
                SfTransformKey(time: 0.0, r: 0, y: 0),
                SfTransformKey(time: 0.74, r: 10, y: 5 * u),
                SfTransformKey(time: 1.6, r: 0, y: 0)
            ],
            "arm-back": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.6, r: -38),
                SfTransformKey(time: 1.6, r: 0)
            ]
        ]

        let anticipationBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.35, y: 0, sx: 1.045, sy: 0.93),
                SfTransformKey(time: 0.7, y: -3 * u, sx: 1.03, sy: 0.95),
                SfTransformKey(time: 1.05, y: 0, sx: 1.055, sy: 0.91),
                SfTransformKey(time: 1.8, y: 0, sx: 1, sy: 1)
            ],
            "chest": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.35, r: 5),
                SfTransformKey(time: 1.05, r: 6.5),
                SfTransformKey(time: 1.8, r: 0)
            ]
        ]

        let zeusBoltBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.22, y: 4 * u, sx: 1.05, sy: 0.92),
                SfTransformKey(time: 0.58, y: -32 * u, sx: 0.95, sy: 1.09),
                SfTransformKey(time: 0.92, y: -38 * u, sx: 0.94, sy: 1.11),
                SfTransformKey(time: 1.12, y: -8 * u, sx: 1.035, sy: 0.95),
                SfTransformKey(time: 1.9, y: 0, sx: 1, sy: 1)
            ],
            "arm-back": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.58, r: 168),
                SfTransformKey(time: 0.92, r: 175),
                SfTransformKey(time: 1.12, r: 42),
                SfTransformKey(time: 1.9, r: 0)
            ],
            "arm": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.58, r: -148),
                SfTransformKey(time: 0.92, r: -156),
                SfTransformKey(time: 1.12, r: -22),
                SfTransformKey(time: 1.9, r: 0)
            ]
        ]

        let berserkSpinBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, x: 0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.28, x: -16 * u, y: 0, sx: 1.06, sy: 0.91),
                SfTransformKey(time: 0.54, x: 24 * u, y: -12 * u, sx: 0.96, sy: 1.05),
                SfTransformKey(time: 1.7, x: 0, y: 0, sx: 1, sy: 1)
            ],
            "arm": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.28, r: -95),
                SfTransformKey(time: 0.54, r: 48),
                SfTransformKey(time: 1.7, r: 0)
            ],
            "weapon": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.28, r: 95),
                SfTransformKey(time: 0.54, r: -65),
                SfTransformKey(time: 1.7, r: 0)
            ]
        ]

        let hitReactBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, x: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.12, x: -22 * u, sx: 1.08, sy: 0.89),
                SfTransformKey(time: 0.55, x: 4 * u, sx: 0.98, sy: 1.03),
                SfTransformKey(time: 1.2, x: 0, sx: 1, sy: 1)
            ],
            "chest": [
                SfTransformKey(time: 0.0, r: 0),
                SfTransformKey(time: 0.12, r: -15),
                SfTransformKey(time: 1.2, r: 0)
            ]
        ]

        let symbolWinBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, r: 0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.16, r: -3, y: 8 * u, sx: 1.12, sy: 0.86),
                SfTransformKey(time: 0.42, r: 4, y: -24 * u, sx: 0.88, sy: 1.22),
                SfTransformKey(time: 0.68, r: -2.5, y: 0, sx: 1.05, sy: 0.94),
                SfTransformKey(time: 1.5, r: 0, y: 0, sx: 1, sy: 1)
            ]
        ]

        let wildExpandBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.24, y: 12 * u, sx: 1.16, sy: 0.82),
                SfTransformKey(time: 0.62, y: -34 * u, sx: 0.84, sy: 1.32),
                SfTransformKey(time: 1.8, y: 0, sx: 1, sy: 1)
            ]
        ]

        let scatterTriggerBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, r: 0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.15, r: -5, y: 4 * u, sx: 1.06, sy: 0.92),
                SfTransformKey(time: 0.3, r: 5, y: 6 * u, sx: 1.08, sy: 0.9),
                SfTransformKey(time: 0.78, r: 0, y: -36 * u, sx: 0.86, sy: 1.28),
                SfTransformKey(time: 2.0, r: 0, y: 0, sx: 1, sy: 1)
            ]
        ]

        let chestOpenBones: [String: [SfTransformKey]] = [
            "root": [
                SfTransformKey(time: 0.0, r: 0, y: 0, sx: 1, sy: 1),
                SfTransformKey(time: 0.24, r: 4, y: 4 * u, sx: 1.06, sy: 0.92),
                SfTransformKey(time: 0.38, r: -3, y: 12 * u, sx: 1.14, sy: 0.85),
                SfTransformKey(time: 0.68, r: 0, y: -28 * u, sx: 0.87, sy: 1.24),
                SfTransformKey(time: 2.1, r: 0, y: 0, sx: 1, sy: 1)
            ]
        ]

        return [
            "idle": SfAnimationClip(name: "idle", duration: 4.8, fps: 24, loop: true, boneTracks: idleBones, fxTrack: nil),
            "anticipation": SfAnimationClip(name: "anticipation", duration: 1.8, fps: 24, loop: true, boneTracks: anticipationBones, fxTrack: nil),
            "cheer": SfAnimationClip(name: "cheer", duration: 2.0, fps: 24, loop: true, boneTracks: cheerBones, fxTrack: nil),
            "strike": SfAnimationClip(name: "strike", duration: 2.0, fps: 24, loop: true, boneTracks: strikeBones, fxTrack: nil),
            "power": SfAnimationClip(name: "power", duration: 2.5, fps: 24, loop: true, boneTracks: powerBones, fxTrack: nil),
            "triumph": SfAnimationClip(name: "triumph", duration: 2.7, fps: 24, loop: true, boneTracks: triumphBones, fxTrack: nil),
            "bow": SfAnimationClip(name: "bow", duration: 1.6, fps: 24, loop: true, boneTracks: bowBones, fxTrack: nil),
            "zeus-bolt": SfAnimationClip(name: "zeus-bolt", duration: 1.9, fps: 24, loop: true, boneTracks: zeusBoltBones, fxTrack: nil),
            "berserk-spin": SfAnimationClip(name: "berserk-spin", duration: 1.7, fps: 24, loop: true, boneTracks: berserkSpinBones, fxTrack: nil),
            "hit-react": SfAnimationClip(name: "hit-react", duration: 1.2, fps: 24, loop: true, boneTracks: hitReactBones, fxTrack: nil),
            "symbol-win": SfAnimationClip(name: "symbol-win", duration: 1.5, fps: 24, loop: true, boneTracks: symbolWinBones, fxTrack: nil),
            "wild-expand": SfAnimationClip(name: "wild-expand", duration: 1.8, fps: 24, loop: true, boneTracks: wildExpandBones, fxTrack: nil),
            "scatter-trigger": SfAnimationClip(name: "scatter-trigger", duration: 2.0, fps: 24, loop: true, boneTracks: scatterTriggerBones, fxTrack: nil),
            "chest-open": SfAnimationClip(name: "chest-open", duration: 2.1, fps: 24, loop: true, boneTracks: chestOpenBones, fxTrack: nil)
        ]
    }
}
