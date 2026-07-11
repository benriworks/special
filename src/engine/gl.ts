/**
 * WebGL2 context creation + capability gating.
 *
 * Requirements: WebGL2 + EXT_color_buffer_float (HDR render targets).
 * If either is missing we render a bilingual DOM fallback and abort boot.
 */

import { t } from '../core/i18n';

/** True when OES_texture_float_linear is available (linear filtering of 32F textures). */
export let hasFloatLinear = false;

export interface GLHandle {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** Registered by the engine; invoked after the context has been restored. */
  onContextRestored: (() => void) | null;
  /** Registered by the engine; invoked when the context is lost. */
  onContextLost: (() => void) | null;
  contextLost: boolean;
}

function showFallback(): void {
  const el = document.createElement('div');
  el.id = 'webgl-fallback';
  el.setAttribute('role', 'alert');
  el.style.cssText = [
    'position:fixed', 'inset:0', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:12px',
    'background:#06080d', 'color:rgba(255,255,255,.92)', 'text-align:center',
    'padding:24px', 'font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI","Noto Sans JP",Meiryo,sans-serif',
    'z-index:1000',
  ].join(';');
  const title = document.createElement('div');
  title.style.cssText = 'font-size:20px;letter-spacing:.35em;font-weight:300;opacity:.9';
  title.textContent = 'LUMINA';
  const ja = document.createElement('p');
  ja.style.cssText = 'margin:0;font-size:15px;line-height:1.7';
  ja.textContent = t('webglFallbackJa');
  const en = document.createElement('p');
  en.style.cssText = 'margin:0;font-size:14px;line-height:1.6;color:rgba(255,255,255,.55)';
  en.textContent = t('webglFallbackEn');
  el.append(title, ja, en);
  document.body.appendChild(el);
}

/**
 * Create the shared WebGL2 context on `canvas`.
 * Returns null (after rendering the DOM fallback) when the device can't run LUMINA.
 */
export function createGL(canvas: HTMLCanvasElement): GLHandle | null {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;

  if (!gl) {
    showFallback();
    return null;
  }

  // HDR render targets are non-negotiable for the whole pipeline.
  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) {
    showFallback();
    return null;
  }

  hasFloatLinear = gl.getExtension('OES_texture_float_linear') !== null;

  const handle: GLHandle = { gl, canvas, onContextRestored: null, onContextLost: null, contextLost: false };

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // signal that we will restore
    handle.contextLost = true;
    handle.onContextLost?.();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    handle.contextLost = false;
    hasFloatLinear = gl.getExtension('OES_texture_float_linear') !== null;
    gl.getExtension('EXT_color_buffer_float');
    handle.onContextRestored?.();
  });

  return handle;
}
