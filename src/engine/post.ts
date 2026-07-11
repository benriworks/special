/**
 * Shared HDR composer (optional for modes, recommended).
 *
 * Usage per frame:
 *   post.begin();                   // binds an RGBA16F scene target + viewport
 *   ... render your mode in LINEAR HDR (values may exceed 1.0) ...
 *   post.end({ exposure: 1.2, bloom: 0.6, vignette: 0.3 });
 *
 * end() tonemaps (1 - exp(-x * exposure)), adds a 2-mip soft bloom, applies a
 * subtle vignette and a blue-noise-ish dither, converts to sRGB and writes to
 * the DEFAULT framebuffer. This is the anti-"clipped additive white" weapon.
 * Deliberately cheap so it stays fast under SwiftShader.
 *
 * The internal HDR targets may be created at LOWER than canvas resolution
 * (e.g. width*quality) — end() always composites to the full drawing buffer
 * with smooth linear upsampling, so quality tiers never hard-pixelate.
 */

import { FS_TRIANGLE_VS, compileProgram, createFBO, drawFullscreen, makeTexture, UniformSetter } from './glutils';

export interface PostOpts {
  exposure?: number; // default 1.2
  bloom?: number;    // default 0.5 (0 disables the bloom taps' contribution)
  vignette?: number; // default 0.25 (0..1)
}

export interface Post {
  begin(): void;
  end(opts?: PostOpts): void;
  resize(w: number, h: number): void;
  destroy(): void;
  /** The HDR scene texture (valid between frames; sample-only). */
  readonly sceneTex: WebGLTexture;
}

const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;   // 1/src size
uniform float uKnee;   // soft threshold on first downsample, 0 on later ones
in vec2 vUv;
out vec4 outColor;
vec3 softThreshold(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uKnee + 0.3, 0.0, 0.6);
  soft = soft * soft / 2.4;
  float contrib = max(soft, br - uKnee) / max(br, 1e-4);
  return c * max(contrib, 0.0);
}
void main() {
  // 4-tap box with a diagonal spread — cheap and smooth enough for 2 mips.
  vec3 a = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 avg = (a + b + c + d) * 0.25;
  outColor = vec4(uKnee > 0.0 ? softThreshold(avg) : avg, 1.0);
}
`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uMip1;
uniform sampler2D uMip2;
uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 outColor;

vec3 toSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
// Interleaved gradient noise — blue-noise-ish dither.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec3 hdr = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uMip1, vUv).rgb * 0.6 + texture(uMip2, vUv).rgb * 0.9;
  hdr += bloom * uBloom;

  // Filmic-ish exponential tonemap: never clips to flat white.
  vec3 mapped = 1.0 - exp(-max(hdr, 0.0) * uExposure);

  // Subtle vignette in linear space.
  vec2 q = vUv - 0.5;
  float vig = 1.0 - uVignette * smoothstep(0.25, 0.95, dot(q, q) * 2.6);
  mapped *= vig;

  vec3 srgb = toSrgb(clamp(mapped, 0.0, 1.0));
  srgb += (ign(gl_FragCoord.xy) - 0.5) / 255.0; // kill banding
  outColor = vec4(srgb, 1.0);
}
`;

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; }

export function createPost(gl: WebGL2RenderingContext, width: number, height: number): Post {
  const downProg = compileProgram(gl, FS_TRIANGLE_VS, DOWNSAMPLE_FS, 'post.downsample');
  const compProg = compileProgram(gl, FS_TRIANGLE_VS, COMPOSITE_FS, 'post.composite');
  const downU = new UniformSetter(gl, downProg);
  const compU = new UniformSetter(gl, compProg);

  let scene!: Target;
  let mip1!: Target;
  let mip2!: Target;
  let w = 0;
  let h = 0;

  function makeTarget(tw: number, th: number): Target {
    const tex = makeTexture(gl, { w: tw, h: th, internalFormat: gl.RGBA16F, filter: gl.LINEAR });
    return { tex, fbo: createFBO(gl, tex), w: tw, h: th };
  }
  function freeTarget(t: Target | undefined): void {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }
  function allocate(nw: number, nh: number): void {
    w = Math.max(1, nw | 0);
    h = Math.max(1, nh | 0);
    scene = makeTarget(w, h);
    mip1 = makeTarget(Math.max(1, w >> 1), Math.max(1, h >> 1));
    mip2 = makeTarget(Math.max(1, w >> 2), Math.max(1, h >> 2));
  }

  allocate(width, height);

  function downsample(src: Target, dst: Target, knee: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(downProg);
    downU.setTexture('uTex', src.tex, 0);
    downU.set2f('uTexel', 1 / src.w, 1 / src.h);
    downU.set1f('uKnee', knee);
    drawFullscreen(gl);
  }

  return {
    get sceneTex() { return scene.tex; },

    begin(): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
    },

    end(opts?: PostOpts): void {
      const exposure = opts?.exposure ?? 1.2;
      const bloom = opts?.bloom ?? 0.5;
      const vignette = opts?.vignette ?? 0.25;

      gl.disable(gl.BLEND);
      downsample(scene, mip1, 0.55);
      downsample(mip1, mip2, 0.0);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(compProg);
      compU.setTexture('uScene', scene.tex, 0);
      compU.setTexture('uMip1', mip1.tex, 1);
      compU.setTexture('uMip2', mip2.tex, 2);
      compU.set1f('uExposure', exposure);
      compU.set1f('uBloom', bloom);
      compU.set1f('uVignette', vignette);
      compU.set2f('uResolution', w, h);
      drawFullscreen(gl);
      gl.activeTexture(gl.TEXTURE0);
    },

    resize(nw: number, nh: number): void {
      if (nw === w && nh === h) return;
      freeTarget(scene);
      freeTarget(mip1);
      freeTarget(mip2);
      allocate(nw, nh);
    },

    destroy(): void {
      freeTarget(scene);
      freeTarget(mip1);
      freeTarget(mip2);
      gl.deleteProgram(downProg);
      gl.deleteProgram(compProg);
    },
  };
}
