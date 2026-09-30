// WebGPU device setup and frame submission. See ARCHITECTURE.md § Rendering.
// M0: clears the canvas to the letterbox color, then fills the game viewport
// with a solid color. Later milestones add the tile pass and the sprite pass here.
import { FILL_WGSL } from './shaders.js';

/** Virtual resolution the game is laid out in (40 × 22.5 tiles of 16 px). */
export const VIEW_W = 640;
export const VIEW_H = 360;

const LETTERBOX = { r: 0, g: 0, b: 0, a: 1 };

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

/** @param {HTMLCanvasElement} canvas */
export async function createRenderer(canvas) {
  if (!navigator.gpu) throw new WebGPUUnavailableError('navigator.gpu is missing');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new WebGPUUnavailableError('no WebGPU adapter available');
  const device = await adapter.requestDevice();

  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  // Fill pipeline
  const fillModule = device.createShaderModule({ label: 'fill', code: FILL_WGSL });
  const fillPipeline = device.createRenderPipeline({
    label: 'fill',
    layout: 'auto',
    vertex: { module: fillModule, entryPoint: 'vs' },
    fragment: { module: fillModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const fillUniform = device.createBuffer({
    label: 'fill params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const fillBindGroup = device.createBindGroup({
    layout: fillPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: fillUniform } }],
  });
  const fillData = new Float32Array(4);

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
   * @param {{background: [number, number, number]}} scene
   */
  function frame(scene) {
    fillData.set(scene.background);
    fillData[3] = 1;
    device.queue.writeBuffer(fillUniform, 0, fillData);

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
    pass.setPipeline(fillPipeline);
    pass.setBindGroup(0, fillBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return {
    device,
    format,
    frame,
    get viewport() { return viewport; },
    /** Resolves if the GPU device is lost (driver reset, tab backgrounded on some platforms). */
    lost: device.lost,
  };
}
