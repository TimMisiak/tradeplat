// Client entry: boot the renderer and network, then run the frame loop.
import { createRenderer, WebGPUUnavailableError } from './gpu/renderer.js';
import { createNet } from './net.js';

// M0 has no HUD text yet, so the background color shows the connection state.
const BACKGROUND = {
  connecting: [0.10, 0.10, 0.14],
  connected: [0.07, 0.12, 0.20],
  disconnected: [0.22, 0.07, 0.08],
};

function showFallback(html) {
  const el = document.getElementById('fallback');
  el.innerHTML = `<span>${html}</span>`;
  el.hidden = false;
  document.getElementById('game').hidden = true;
}

async function boot() {
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
  let renderer;
  try {
    renderer = await createRenderer(canvas);
  } catch (err) {
    if (!(err instanceof WebGPUUnavailableError)) console.error(err);
    showFallback(
      'This game needs WebGPU, and this browser doesn\'t have it available.<br>' +
      'Try a current Chrome, Edge or Safari. ' +
      '<a href="https://caniuse.com/webgpu">Browser support</a>',
    );
    return;
  }

  renderer.lost.then((info) => {
    console.error('[gpu] device lost:', info.reason, info.message);
    if (info.reason !== 'destroyed') showFallback('The graphics device was lost. Reload the page to continue.');
  });

  const params = new URLSearchParams(location.search);
  const net = createNet({ name: params.get('name') ?? 'Trader' });

  // Handles for poking at the client from the dev console.
  globalThis.game = { renderer, net };

  function frame() {
    renderer.frame({ background: BACKGROUND[net.status] });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
