/**
 * WebGL2 Skinning + FFD + Heatmap + 3D Normal-Map Relighting + Onion-Skin Renderer (`src/core/webgl-renderer.ts`)
 *
 * Renders:
 * 1. Premultiplied 4-bone Linear Blend Skinning (LBS) + per-vertex FFD offsets (`aDeform`)
 * 2. Real-time 3D Normal-Map Point Relighting (`uLightDir`, `uLightIntensity`, `uTexel`) via Sobel alpha/luma gradients
 * 3. Multi-Skin Wardrobe Tint (`uSkinTint`) + Rim (`uRim`) + Power Flash (`uFlashTint`)
 * 4. Onion-Skinning Ghost Frames (`uGhostTint`) for previous/next frame animation spacing
 * 5. Live GPU weight-painting thermal/bone heatmap blend (`uHeatmapMix`)
 */

import { buildPartMesh } from "./weights";
import type { PartMeshData, SpineForgeProject } from "./schema";
import type { BuiltSkeleton } from "./solver";

/** User camera on top of the fit-to-window baseline (session-only; not part of the project). */
export type ViewCamera = { zoom: number; panX: number; panY: number };

export const VIEW_ZOOM_MIN = 0.25;
export const VIEW_ZOOM_MAX = 8;
/** Keyboard / button zoom step (multiplicative). */
export const VIEW_ZOOM_STEP = 1.12;

/** Fit-to-window metrics, then optional zoom/pan. Shared by WebGL, overlay, and store zoomAt. */
export function computeViewMetrics(
  project: Pick<SpineForgeProject, "width" | "height" | "frame">,
  width: number,
  height: number,
  camera?: Partial<ViewCamera> | null,
): { scale: number; offsetX: number; offsetY: number; artW: number; artH: number; fitScale: number } {
  const { width: artW, height: artH, frame } = project;
  const leftM = frame.left ?? 0.25;
  const rightM = frame.right ?? 0.25;
  const topM = frame.top ?? 0.2;
  const bottomM = frame.bottom ?? 0.05;
  const spanW = artW * (1 + leftM + rightM);
  const spanH = artH * (1 + topM + bottomM);
  const fitScale = Math.min(width / spanW, height / spanH);
  const zoom = camera?.zoom ?? 1;
  const scale = fitScale * zoom;
  const offsetX = (width - spanW * fitScale) / 2 + leftM * artW * fitScale + (camera?.panX ?? 0);
  const offsetY = (height - spanH * fitScale) / 2 + topM * artH * fitScale + (camera?.panY ?? 0);
  return { scale, offsetX, offsetY, artW, artH, fitScale };
}

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
in vec2 aDeform;
in vec2 aUv;
in vec4 aJoint;
in vec4 aWeight;
in vec4 aHeatColor;

uniform vec4 uBones[64];
uniform vec4 uView;

out vec2 vUv;
out vec4 vHeatColor;

vec2 skin(float j, vec2 p) {
  int i = int(j) * 2;
  vec4 m = uBones[i];
  vec4 t = uBones[i + 1];
  return vec2(m.x * p.x + m.z * p.y + t.x, m.y * p.x + m.w * p.y + t.y);
}

void main() {
  vec2 basePos = aPos + aDeform;
  vec2 p = skin(aJoint.x, basePos) * aWeight.x
         + skin(aJoint.y, basePos) * aWeight.y
         + skin(aJoint.z, basePos) * aWeight.z
         + skin(aJoint.w, basePos) * aWeight.w;
  vUv = aUv;
  vHeatColor = aHeatColor;
  gl_Position = vec4(p.x * uView.x + uView.z, p.y * uView.y + uView.w, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec4 vHeatColor;

uniform sampler2D uTex;
uniform vec3 uRim;
uniform vec3 uFlashTint;
uniform vec3 uSkinTint;
uniform vec4 uGhostTint;
uniform vec3 uLightDir;
uniform float uLightIntensity;
uniform vec2 uTexel;
uniform float uFlash;
uniform float uHeatmapMix;
uniform float uPartOpacity;

out vec4 outColor;

float heightSample(vec2 uv) {
  vec4 s = texture(uTex, uv);
  return (dot(s.rgb, vec3(0.299, 0.587, 0.114)) * 0.65 + s.a * 0.35);
}

void main() {
  vec4 c = texture(uTex, vUv);
  if (c.a < 0.005) discard;

  // Onion-skin ghost pass
  if (uGhostTint.a > 0.01) {
    float ga = c.a * uGhostTint.a;
    outColor = vec4(uGhostTint.rgb * ga, ga);
    return;
  }

  // Apply Multi-Skin Wardrobe tint
  c.rgb *= uSkinTint;

  // Real-time 3D Normal-Map Relighting from Sobel height/alpha gradient
  if (uLightIntensity > 0.01) {
    float hL = heightSample(vUv - vec2(uTexel.x * 2.0, 0.0));
    float hR = heightSample(vUv + vec2(uTexel.x * 2.0, 0.0));
    float hU = heightSample(vUv - vec2(0.0, uTexel.y * 2.0));
    float hD = heightSample(vUv + vec2(0.0, uTexel.y * 2.0));
    vec3 norm = normalize(vec3((hL - hR) * 3.2, (hU - hD) * 3.2, 1.0));
    vec3 L = normalize(uLightDir);
    float ndotl = max(0.18, dot(norm, L));
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float spec = pow(max(0.0, dot(norm, H)), 20.0) * 0.45 * c.a;
    vec3 litRgb = c.rgb * (0.55 + 0.75 * ndotl) + uRim * spec;
    c.rgb = mix(c.rgb, litRgb, uLightIntensity);
  }

  c.rgb += uFlashTint * uFlash * 0.25 * c.a;
  if (uHeatmapMix > 0.01 && c.a > 0.02) {
    vec3 heatPremult = vHeatColor.rgb * c.a;
    c.rgb = mix(c.rgb, heatPremult, uHeatmapMix * vHeatColor.a);
  }
  c.rgb = min(c.rgb, vec3(c.a));
  outColor = c * uPartOpacity;
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "WebGL2 shader compile failed");
  }
  return shader;
}

function hexToRgbNorm(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", "").slice(0, 6), 16) || 0;
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

type PartGlState = {
  name: string;
  mesh: PartMeshData;
  vao: WebGLVertexArrayObject;
  posBuffer: WebGLBuffer;
  deformBuffer: WebGLBuffer;
  weightBuffer: WebGLBuffer;
  jointBuffer: WebGLBuffer;
  heatBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  vertexCount: number;
  texture: WebGLTexture;
  texel: [number, number];
};

export type GhostFramePass = {
  skin: Float32Array;
  order: readonly string[];
  /** Premultiplied ghost tint [r, g, b, opacity]. */
  tint: [number, number, number, number];
};

export class SpineForgeWebGLRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  private parts = new Map<string, PartGlState>();
  private allBuffers: WebGLBuffer[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private skeleton: BuiltSkeleton,
    images: Record<string, HTMLImageElement | ImageBitmap>,
    options?: { preserveDrawingBuffer?: boolean },
  ) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: options?.preserveDrawingBuffer ?? true,
    });
    if (!gl) throw new Error("WebGL2 context unavailable");
    this.gl = gl;

    const program = gl.createProgram()!;
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "WebGL2 program link failed");
    }
    this.program = program;

    this.uniforms = Object.fromEntries(
      [
        "uBones",
        "uView",
        "uTex",
        "uRim",
        "uFlashTint",
        "uSkinTint",
        "uGhostTint",
        "uLightDir",
        "uLightIntensity",
        "uTexel",
        "uFlash",
        "uHeatmapMix",
        "uPartOpacity",
      ].map((n) => [n, gl.getUniformLocation(program, n)]),
    );

    gl.useProgram(program);
    gl.uniform1i(this.uniforms.uTex!, 0);
    gl.uniform3fv(this.uniforms.uRim!, hexToRgbNorm(skeleton.project.palette.rim));
    gl.uniform3fv(this.uniforms.uFlashTint!, hexToRgbNorm(skeleton.project.palette.flash));
    gl.uniform3fv(this.uniforms.uSkinTint!, [1, 1, 1]);
    gl.uniform4fv(this.uniforms.uGhostTint!, [0, 0, 0, 0]);
    gl.uniform3fv(this.uniforms.uLightDir!, [0.35, -0.45, 0.82]);
    gl.uniform1f(this.uniforms.uLightIntensity!, 0);

    this.rebuildParts(skeleton.project, images);
  }

  rebuildParts(project: SpineForgeProject, images: Record<string, HTMLImageElement | ImageBitmap>): void {
    const { gl, program } = this;
    for (const part of project.parts) {
      const image = images[part.name];
      if (!image) continue;
      const mesh = part.mesh ?? buildPartMesh(project, part);
      part.mesh = mesh;
      const vCount = mesh.positions.length / 2;

      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);

      const makeAttr = (name: string, data: Float32Array, size: number, usage: number = gl.DYNAMIC_DRAW) => {
        const buf = gl.createBuffer()!;
        this.allBuffers.push(buf);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, usage);
        const loc = gl.getAttribLocation(program, name);
        if (loc >= 0) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        }
        return buf;
      };

      const posBuffer = makeAttr("aPos", new Float32Array(mesh.positions), 2);
      const deformBuffer = makeAttr("aDeform", new Float32Array(vCount * 2), 2);
      makeAttr("aUv", new Float32Array(mesh.uvs), 2, gl.STATIC_DRAW);
      const jointBuffer = makeAttr("aJoint", new Float32Array(mesh.joints), 4);
      const weightBuffer = makeAttr("aWeight", new Float32Array(mesh.weights), 4);
      const heatBuffer = makeAttr("aHeatColor", new Float32Array(vCount * 4), 4);

      const indexBuffer = gl.createBuffer()!;
      this.allBuffers.push(indexBuffer);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indices), gl.STATIC_DRAW);
      gl.bindVertexArray(null);

      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const imgW = "naturalWidth" in image ? image.naturalWidth || image.width : image.width;
      const imgH = "naturalHeight" in image ? image.naturalHeight || image.height : image.height;

      this.parts.set(part.name, {
        name: part.name,
        mesh,
        vao,
        posBuffer,
        deformBuffer,
        weightBuffer,
        jointBuffer,
        heatBuffer,
        indexBuffer,
        indexCount: mesh.indices.length,
        vertexCount: vCount,
        texture,
        texel: [1 / Math.max(1, imgW), 1 / Math.max(1, imgH)],
      });
    }
  }

  updatePartWeightsAndHeatmap(partName: string, mesh: PartMeshData, heatColors?: Float32Array): void {
    const { gl } = this;
    const state = this.parts.get(partName);
    if (!state) return;
    state.mesh = mesh;
    gl.bindBuffer(gl.ARRAY_BUFFER, state.jointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.joints), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.weightBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.weights), gl.DYNAMIC_DRAW);
    if (heatColors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, state.heatBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, heatColors, gl.DYNAMIC_DRAW);
    }
  }

  getViewMetrics(width: number, height: number, camera?: ViewCamera | null) {
    return computeViewMetrics(this.skeleton.project, width, height, camera);
  }

  draw(options: {
    skin: Float32Array;
    order?: readonly string[];
    deforms?: Record<string, number[] | undefined>;
    flash?: number;
    heatmapMix?: number;
    selectedPart?: string | null;
    isolateSelectedPart?: boolean;
    fixedSize?: { width: number; height: number };
    /** Cap / override for devicePixelRatio (from Preferences → Performance). */
    pixelRatio?: number;
    /** Session camera (zoom/pan) on top of fit-to-window. */
    camera?: ViewCamera | null;
    skinTintHex?: string;
    rimHex?: string;
    flashHex?: string;
    lightDir?: [number, number, number];
    lightIntensity?: number;
    ghostFrames?: GhostFramePass[];
  }): void {
    const { gl, canvas } = this;
    const dpr = Math.max(0.75, Math.min(2, options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2)));
    const width = options.fixedSize
      ? options.fixedSize.width
      : Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = options.fixedSize
      ? options.fixedSize.height
      : Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const { scale, offsetX, offsetY } = this.getViewMetrics(width, height, options.camera);

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);
    gl.uniform4f(
      this.uniforms.uView!,
      (2 * scale) / width,
      (-2 * scale) / height,
      (2 * offsetX) / width - 1,
      1 - (2 * offsetY) / height,
    );

    gl.activeTexture(gl.TEXTURE0);
    const drawList = options.order ?? Array.from(this.parts.keys());

    // 1. Render Onion-Skin Ghost Frames first (behind main character)
    if (options.ghostFrames && options.ghostFrames.length > 0) {
      gl.uniform1f(this.uniforms.uHeatmapMix!, 0);
      gl.uniform1f(this.uniforms.uLightIntensity!, 0);
      gl.uniform1f(this.uniforms.uPartOpacity!, 1.0);
      for (const ghost of options.ghostFrames) {
        gl.uniform4fv(this.uniforms.uBones!, ghost.skin);
        gl.uniform4fv(this.uniforms.uGhostTint!, ghost.tint);
        for (const name of ghost.order) {
          const part = this.parts.get(name);
          if (!part) continue;
          gl.bindTexture(gl.TEXTURE_2D, part.texture);
          gl.bindVertexArray(part.vao);
          gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
        }
      }
      gl.uniform4fv(this.uniforms.uGhostTint!, [0, 0, 0, 0]);
    }

    // 2. Render Main Live Character Pass
    gl.uniform4fv(this.uniforms.uBones!, options.skin);
    gl.uniform1f(this.uniforms.uFlash!, options.flash ?? 0);
    gl.uniform3fv(
      this.uniforms.uSkinTint!,
      options.skinTintHex ? hexToRgbNorm(options.skinTintHex) : [1, 1, 1],
    );
    gl.uniform3fv(
      this.uniforms.uRim!,
      hexToRgbNorm(options.rimHex ?? this.skeleton.project.palette.rim),
    );
    gl.uniform3fv(
      this.uniforms.uFlashTint!,
      hexToRgbNorm(options.flashHex ?? this.skeleton.project.palette.flash),
    );
    gl.uniform3fv(this.uniforms.uLightDir!, options.lightDir ?? [0.35, -0.45, 0.82]);
    gl.uniform1f(this.uniforms.uLightIntensity!, options.lightIntensity ?? 0);

    for (const name of drawList) {
      const part = this.parts.get(name);
      if (!part) continue;
      if (options.isolateSelectedPart && options.selectedPart && options.selectedPart !== name) {
        gl.uniform1f(this.uniforms.uPartOpacity!, 0.18);
      } else {
        gl.uniform1f(this.uniforms.uPartOpacity!, 1.0);
      }

      const showHeat =
        (options.heatmapMix ?? 0) > 0 && (!options.selectedPart || options.selectedPart === name)
          ? (options.heatmapMix ?? 0)
          : 0;
      gl.uniform1f(this.uniforms.uHeatmapMix!, showHeat);
      gl.uniform2f(this.uniforms.uTexel!, part.texel[0], part.texel[1]);

      const deform = options.deforms?.[name];
      gl.bindBuffer(gl.ARRAY_BUFFER, part.deformBuffer);
      if (deform && deform.length === part.vertexCount * 2) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(deform));
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(part.vertexCount * 2));
      }

      gl.bindTexture(gl.TEXTURE_2D, part.texture);
      gl.bindVertexArray(part.vao);
      gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  destroy(): void {
    const { gl } = this;
    this.allBuffers.forEach((b) => gl.deleteBuffer(b));
    for (const part of this.parts.values()) {
      gl.deleteVertexArray(part.vao);
      gl.deleteTexture(part.texture);
    }
    gl.deleteProgram(this.program);
  }
}
