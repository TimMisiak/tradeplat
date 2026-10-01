// WebGPU device setup and frame submission. See ARCHITECTURE.md § Rendering.
// Passes inside the letterboxed viewport: tiles (one fullscreen triangle reading an
// r8uint map texture), then world sprites (instanced quads), then UI quads (the same
// pipeline in screen space, textured from the glyph/icon atlas in ui/text.js).
import { SPRITE_WGSL, TILE_WGSL } from './shaders.js';

/** Virtual resolution the game is laid out in (40 × 22.5 tiles of 16 px). */
export const VIEW_W = 640;
export const VIEW_H = 360;

const LETTERBOX = { r: 0, g: 0, b: 0, a: 1 };
const MAX_TILE_STYLES = 16;
const STYLE_FLOATS = 16; // fill + edge + params + flags, 4 floats each
const INSTANCE_FLOATS = 12; // rect vec4 + color vec4 + uv vec4

export class WebGPUUnavailableError extends Error {}

/**
 * Largest integer scale of the virtual view that fits the canvas, centred.
 * Falls back to a fractional scale below 1× so a tiny window still shows everything.
 */
export function computeViewport(canvasW, canvasH) {
  const fit = Math.min(canvasW / VIEW_W, canvasH / VIEW_H);
  const scale = fit >= 1 ? Math.floor(fit) : fit;
  const w = Math.max(1, Math.round(VIEW_W * scale));
  const h = Math.max(1, Math.round(VIEW_H * scale));
  return { scale, x: Math.floor((canvasW - w) / 2), y: Math.floor((canvasH - h) / 2), w, h };
}

/**
 * CPU-side list of sprite instances for one frame. Reused between frames.
 * push() takes world-space px; uv is in atlas texels (omit for a flat color).
 */
export class SpriteBatch {
  constructor(capacity = 256) {
    this.data = new Float32Array(capacity * INSTANCE_FLOATS);
    this.count = 0;
  }
  clear() { this.count = 0; }
  push(x, y, w, h, [r, g, b, a = 1], uv) {
    if ((this.count + 1) * INSTANCE_FLOATS > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const d = this.data;
    let o = this.count++ * INSTANCE_FLOATS;
    d[o++] = x; d[o++] = y; d[o++] = w; d[o++] = h;
    d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a;
    if (uv) { d[o++] = uv[0]; d[o++] = uv[1]; d[o++] = uv[2]; d[o++] = uv[3]; }
    else { d[o++] = 0; d[o++] = 0; d[o++] = 0; d[o++] = 0; }
  }
}

/** @param {HTMLCanvasElement} canvas */
export async function createRenderer(canvas) {
  if (!navigator.gpu) throw new WebGPUUnavailableError('navigator.gpu is missing');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new WebGPUUnavailableError('no WebGPU adapter available');
  const device = await adapter.requestDevice();

  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  // View uniforms (shared)
  const viewData = new Float32Array(8);
  const viewBuf = device.createBuffer({ label: 'view', size: viewData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  // The UI pass uses the same layout with the camera at 0,0 (virtual screen px).
  const uiViewBuf = device.createBuffer({ label: 'ui view', size: viewData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // Tile pass
  const tileModule = device.createShaderModule({ label: 'tiles', code: TILE_WGSL });
  const tilePipeline = device.createRenderPipeline({
    label: 'tiles',
    layout: 'auto',
    vertex: { module: tileModule, entryPoint: 'vs' },
    fragment: { module: tileModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const styleData = new Float32Array(MAX_TILE_STYLES * STYLE_FLOATS);
  const styleBuf = device.createBuffer({ label: 'tile styles', size: styleData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let tileTex = null;
  let tileBindGroup = null;
  let mapSize = [0, 0];
  // Tile art: a 16×16 texture array (see assets.js loadTileArt). A 1-layer dummy until set.
  let tileArtTex = device.createTexture({ size: [16, 16, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  function rebuildTileBindGroup() {
    if (!tileTex) return;
    tileBindGroup = device.createBindGroup({
      layout: tilePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: viewBuf } },
        { binding: 1, resource: { buffer: styleBuf } },
        { binding: 2, resource: tileTex.createView() },
        { binding: 3, resource: tileArtTex.createView({ dimension: '2d-array' }) },
      ],
    });
  }

  // Sprite pass
  const spriteModule = device.createShaderModule({ label: 'sprites', code: SPRITE_WGSL });
  const spritePipeline = device.createRenderPipeline({
    label: 'sprites',
    layout: 'auto',
    vertex: {
      module: spriteModule,
      entryPoint: 'vs',
      buffers: [{
        arrayStride: INSTANCE_FLOATS * 4,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
          { shaderLocation: 2, offset: 32, format: 'float32x4' },
        ],
      }],
    },
    fragment: {
      module: spriteModule,
      entryPoint: 'fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  let instanceBuf = null;
  let spriteBindGroup = null;

  /** Replace the sprite atlas (a GPUTexture). The default is a 1×1 white texel. */
  function setAtlas(texture) {
    spriteBindGroup = device.createBindGroup({
      layout: spritePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: viewBuf } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: sampler },
      ],
    });
  }
  const white = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  setAtlas(white);

  // UI atlas (glyphs + icons), re-uploaded from its canvas whenever it changes.
  let uiTex = null;
  let uiBindGroup = null;
  /** @param {{canvas: OffscreenCanvas, dirty: boolean}} atlas */
  function syncUiAtlas(atlas) {
    if (!atlas.dirty && uiTex) return;
    const { width, height } = atlas.canvas;
    if (!uiTex || uiTex.width !== width || uiTex.height !== height) {
      uiTex?.destroy();
      uiTex = device.createTexture({
        label: 'ui atlas',
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      uiBindGroup = device.createBindGroup({
        layout: spritePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uiViewBuf } },
          { binding: 1, resource: uiTex.createView() },
          { binding: 2, resource: sampler },
        ],
      });
    }
    device.queue.copyExternalImageToTexture({ source: atlas.canvas }, { texture: uiTex }, [width, height]);
    atlas.dirty = false;
  }

  /** Use a tile art texture array (layers referenced by style `art.layer`). */
  function setTileArt(texture) {
    tileArtTex = texture;
    rebuildTileBindGroup();
  }

  /**
   * Upload a tile map and its style table.
   * @param {import('../../shared/tiles.js').TileMap} map
   * @param {TileStyle[]} styles indexed by tile id
   *
   * @typedef {{fill: number[], edge?: number[], shape?: number, edgeWidth?: number, solid?: boolean,
   *   mirror?: boolean, art?: {layer: number, autotile: boolean}}} TileStyle
   */
  function setMap(map, styles) {
    tileTex?.destroy();
    tileTex = device.createTexture({
      label: 'tile map',
      size: [map.w, map.h],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // writeTexture needs bytesPerRow to be a multiple of 256 only for buffer copies, not here.
    device.queue.writeTexture({ texture: tileTex }, map.tiles, { bytesPerRow: map.w }, [map.w, map.h]);
    mapSize = [map.w, map.h];

    styleData.fill(0);
    for (let id = 0; id < MAX_TILE_STYLES; id++) styleData[id * STYLE_FLOATS + 10] = -1; // no art
    styles.slice(0, MAX_TILE_STYLES).forEach((s, id) => {
      if (!s) return;
      const o = id * STYLE_FLOATS;
      styleData.set(s.fill, o);
      styleData[o + 3] = s.fill[3] ?? 1;
      if (s.edge) { styleData.set(s.edge, o + 4); styleData[o + 7] = s.edge[3] ?? 1; }
      styleData[o + 8] = s.shape ?? 0;
      styleData[o + 9] = s.edgeWidth ?? 0;
      styleData[o + 10] = s.art ? s.art.layer : -1;
      styleData[o + 11] = s.art?.autotile ? 1 : 0;
      styleData[o + 12] = s.solid ? 1 : 0;
      styleData[o + 13] = s.mirror ? 1 : 0;
    });
    device.queue.writeBuffer(styleBuf, 0, styleData);
    rebuildTileBindGroup();
  }

  /** Change one tile after setMap (e.g. breakable blocks later). */
  function setTile(tx, ty, id) {
    device.queue.writeTexture({ texture: tileTex, origin: [tx, ty] }, new Uint8Array([id]), { bytesPerRow: 1 }, [1, 1]);
  }

  // Canvas sizing. Size the backing store in device pixels: the ResizeObserver's
  // device-pixel box is exact where it's supported; otherwise use CSS size × DPR.
  const maxDim = device.limits.maxTextureDimension2D;
  let viewport = computeViewport(1, 1);
  function setSize(w, h) {
    canvas.width = Math.max(1, Math.min(maxDim, w));
    canvas.height = Math.max(1, Math.min(maxDim, h));
    viewport = computeViewport(canvas.width, canvas.height);
  }
  const observer = new ResizeObserver(([entry]) => {
    const dpBox = entry.devicePixelContentBoxSize?.[0];
    if (dpBox) {
      setSize(dpBox.inlineSize, dpBox.blockSize);
    } else {
      const box = entry.contentBoxSize[0];
      setSize(Math.round(box.inlineSize * devicePixelRatio), Math.round(box.blockSize * devicePixelRatio));
    }
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas);
  }
  setSize(Math.round(canvas.clientWidth * devicePixelRatio), Math.round(canvas.clientHeight * devicePixelRatio));

  /**
   * Draw one frame.
   * @param {{cam: [number, number], sprites: SpriteBatch, ui?: SpriteBatch & {atlas?: any}}} scene
   *   cam = view top-left in world px. ui is in virtual screen px, textured from ui.atlas.
   */
  function frame({ cam, sprites, ui }) {
    viewData.set([Math.round(cam[0]), Math.round(cam[1]), VIEW_W, VIEW_H, mapSize[0], mapSize[1], 0, 0]);
    device.queue.writeBuffer(viewBuf, 0, viewData);
    viewData.set([0, 0]);
    device.queue.writeBuffer(uiViewBuf, 0, viewData);

    const uiCount = ui?.atlas && ui.count > 0 ? ui.count : 0;
    if (uiCount) syncUiAtlas(ui.atlas);
    const total = sprites.count + uiCount;
    if (total > 0) {
      const bytes = total * INSTANCE_FLOATS * 4;
      if (!instanceBuf || instanceBuf.size < bytes) {
        instanceBuf?.destroy();
        instanceBuf = device.createBuffer({ label: 'sprite instances', size: Math.max(bytes, 64 * 1024), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      device.queue.writeBuffer(instanceBuf, 0, sprites.data, 0, sprites.count * INSTANCE_FLOATS);
      if (uiCount) device.queue.writeBuffer(instanceBuf, sprites.count * INSTANCE_FLOATS * 4, ui.data, 0, uiCount * INSTANCE_FLOATS);
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: LETTERBOX,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
    pass.setScissorRect(viewport.x, viewport.y, viewport.w, viewport.h);
    if (tileBindGroup) {
      pass.setPipeline(tilePipeline);
      pass.setBindGroup(0, tileBindGroup);
      pass.draw(3);
    }
    if (sprites.count > 0) {
      pass.setPipeline(spritePipeline);
      pass.setBindGroup(0, spriteBindGroup);
      pass.setVertexBuffer(0, instanceBuf);
      pass.draw(6, sprites.count);
    }
    if (uiCount) {
      pass.setPipeline(spritePipeline);
      pass.setBindGroup(0, uiBindGroup);
      pass.setVertexBuffer(0, instanceBuf);
      pass.draw(6, uiCount, 0, sprites.count);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return {
    device,
    format,
    frame,
    setMap,
    setTile,
    setAtlas,
    setTileArt,
    get viewport() { return viewport; },
    /** Resolves if the GPU device is lost (driver reset, tab backgrounded on some platforms). */
    lost: device.lost,
  };
}
