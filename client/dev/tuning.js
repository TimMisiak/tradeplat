// Dev-only movement tuning panel (DESIGN.md § Movement feel). Toggle with ` (backquote).
// Plain DOM, since it's a tool and not part of the game UI. Edits apply live to
// `tuning`, which the local simulation passes to step(). They persist in this browser
// only. "Copy" puts the values on the clipboard to paste into TUNING in
// shared/physics.js, which is the only place the real values live.
import { TUNING } from '../../shared/physics.js';

const STORAGE_KEY = 'pt.dev.tuning';
const INTEGER_KEYS = new Set(['width', 'height', 'coyoteTicks', 'jumpBufferTicks', 'wallLockTicks', 'wallCoyoteTicks']);

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in TUNING && typeof v === 'number'));
  } catch {
    return {};
  }
}
function save(tuning) {
  try {
    const changed = Object.fromEntries(Object.entries(tuning).filter(([k, v]) => v !== TUNING[k]));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changed));
  } catch { /* storage blocked: edits just don't persist */ }
}

export function createTuningPanel() {
  const tuning = { ...TUNING, ...loadSaved() };

  const root = document.createElement('div');
  root.id = 'dev-tuning';
  root.hidden = true;
  root.innerHTML = `
    <style>
      #dev-tuning { position: fixed; top: 8px; right: 8px; width: 300px; max-height: calc(100vh - 16px); overflow: auto;
        background: #10131ce8; color: #e8e6df; font: 12px/1.3 ui-monospace, monospace; padding: 8px 10px;
        border: 1px solid #2a3040; border-radius: 6px; z-index: 10; }
      #dev-tuning[hidden] { display: none; }
      #dev-tuning h3 { margin: 0 0 6px; font-size: 12px; color: #5fb3d9; }
      #dev-tuning .row { display: grid; grid-template-columns: 1fr 90px 52px; gap: 4px; align-items: center; margin: 2px 0; }
      #dev-tuning .row.changed label { color: #f2c14e; }
      #dev-tuning input[type=number] { width: 52px; background: #1b2030; color: inherit; border: 1px solid #2a3040; font: inherit; }
      #dev-tuning input[type=range] { width: 90px; }
      #dev-tuning pre { margin: 6px 0; white-space: pre-wrap; color: #8a93a6; }
      #dev-tuning button { font: inherit; margin-right: 4px; }
    </style>
    <h3>movement tuning <small>(\` to hide)</small></h3>
    <pre class="state"></pre>
    <div class="rows"></div>
    <div style="margin-top:6px">
      <button data-act="copy">copy</button><button data-act="reset">reset all</button>
      <span class="msg"></span>
    </div>`;
  const rows = root.querySelector('.rows');
  const statePre = root.querySelector('.state');
  const msg = root.querySelector('.msg');

  const controls = {};
  for (const key of Object.keys(TUNING)) {
    const base = TUNING[key];
    const int = INTEGER_KEYS.has(key);
    const max = int ? Math.max(base * 3, 10) : Math.max(base * 3, 1);
    const stepSize = int ? 1 : base >= 1 ? 0.05 : 0.01;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label title="default ${base}">${key}</label>
      <input type="range" min="0" max="${max}" step="${stepSize}">
      <input type="number" min="0" step="${stepSize}">`;
    const [range, num] = row.querySelectorAll('input');
    const set = (v) => {
      if (!Number.isFinite(v)) return;
      tuning[key] = int ? Math.round(v) : v;
      range.value = num.value = String(tuning[key]);
      row.classList.toggle('changed', tuning[key] !== base);
      save(tuning);
    };
    range.oninput = () => set(+range.value);
    num.onchange = () => set(+num.value);
    controls[key] = set;
    set(tuning[key]);
    rows.append(row);
  }

  root.addEventListener('click', async (e) => {
    const act = e.target.dataset?.act;
    if (act === 'reset') {
      for (const [k, set] of Object.entries(controls)) set(TUNING[k]);
      msg.textContent = 'reset';
    } else if (act === 'copy') {
      const body = Object.entries(tuning).map(([k, v]) => `  ${k}: ${v},`).join('\n');
      try {
        await navigator.clipboard.writeText(`{\n${body}\n}`);
        msg.textContent = 'copied';
      } catch {
        console.log(`{\n${body}\n}`);
        msg.textContent = 'clipboard blocked, logged to console';
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') { root.hidden = !root.hidden; e.preventDefault(); }
  });
  document.body.append(root);

  return {
    tuning,
    get visible() { return !root.hidden; },
    /** Refresh the live readout (call once per frame; cheap when hidden). */
    show(lines) {
      if (!root.hidden) statePre.textContent = lines;
    },
  };
}
