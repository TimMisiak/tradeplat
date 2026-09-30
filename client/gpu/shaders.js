// WGSL source strings. They're kept in JS modules so there is no fetch or build step.

/** Per-frame view uniforms, shared by the tile and sprite passes. Layout must match renderer.js. */
const VIEW_STRUCT = /* wgsl */ `
struct View {
  cam: vec2f,      // top-left of the view in world px (whole pixels)
  size: vec2f,     // view size in virtual px (640 × 360)
  mapSize: vec2f,  // map size in tiles
  _pad: vec2f,
};
`;

/**
 * Tile pass: one fullscreen triangle. Each fragment finds its world pixel,
 * looks up the tile id in an r8uint texture, and shades it from a per-tile style
 * table: tile art from a texture array if the tile has any (ART.md), otherwise a
 * flat palette shape. Cost doesn't depend on map size.
 */
export const TILE_WGSL = /* wgsl */ `
${VIEW_STRUCT}
struct TileStyle {
  fill: vec4f,     // flat color
  edge: vec4f,     // flat color for exposed edges (a = 0 → no edge)
  params: vec4f,   // x: shape (0 block, 1 top strip, 2 spikes, 3 ramp), y: edge width px,
                   // z: first art layer (-1 = no art), w: 1 if the art is a cardinal4 strip
  flags: vec4f,    // x: 1 if solid for joins and spike attachment, y: 1 to mirror (slopeL)
};
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<uniform> styles: array<TileStyle, 16>;
@group(0) @binding(2) var tiles: texture_2d<u32>;
@group(0) @binding(3) var tileArt: texture_2d_array<f32>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VsOut;
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y); // y down, like the world
  return out;
}

fn tileId(t: vec2i) -> u32 {
  let m = vec2i(view.mapSize);
  if (t.x < 0 || t.y < 0 || t.x >= m.x || t.y >= m.y) { return 1u; } // outside = solid
  return textureLoad(tiles, t, 0).r;
}

fn isSolid(t: vec2i) -> bool {
  return styles[min(tileId(t), 15u)].flags.x > 0.5;
}

fn joins(id: u32, solid: bool, n: vec2i) -> bool {
  let nid = tileId(n);
  return nid == id || (solid && styles[min(nid, 15u)].flags.x > 0.5);
}

/**
 * Spikes are authored pointing up. Map a pixel of this tile to the art pixel,
 * rotated so the base sits on the solid neighbour: below, else above, else left, else right.
 */
fn spikeLocal(t: vec2i, l: vec2f) -> vec2f {
  if (isSolid(t + vec2i(0, 1))) { return l; }
  if (isSolid(t + vec2i(0, -1))) { return vec2f(15.0 - l.x, 15.0 - l.y); }
  if (isSolid(t + vec2i(-1, 0))) { return vec2f(l.y, 15.0 - l.x); }
  if (isSolid(t + vec2i(1, 0))) { return vec2f(15.0 - l.y, l.x); }
  return l;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let world = view.cam + floor(in.uv * view.size);
  let t = vec2i(floor(world / 16.0));
  var local = world - vec2f(t) * 16.0; // 0..15, pixel within the tile
  let id = tileId(t);
  let sky = styles[0].fill;
  if (id == 0u) { return sky; }
  let st = styles[min(id, 15u)];
  let shape = u32(st.params.x);
  if (shape == 2u) { local = spikeLocal(t, local); }
  if (st.flags.y > 0.5) { local.x = 15.0 - local.x; } // '\\' is '/' mirrored

  // Joined neighbours, N=1 E=2 S=4 W=8 (the cardinal4 layout in ART.md). A neighbour
  // joins if it's the same tile, or if both are solid (terrain under a post floor
  // shouldn't grow a grass edge).
  let solid = st.flags.x > 0.5;
  var mask = 0;
  if (joins(id, solid, t + vec2i(0, -1))) { mask |= 1; }
  if (joins(id, solid, t + vec2i(1, 0))) { mask |= 2; }
  if (joins(id, solid, t + vec2i(0, 1))) { mask |= 4; }
  if (joins(id, solid, t + vec2i(-1, 0))) { mask |= 8; }

  if (st.params.z >= 0.0) {
    var layer = i32(st.params.z);
    if (st.params.w > 0.5) { layer += mask; }
    let c = textureLoad(tileArt, vec2i(local), layer, 0);
    return mix(sky, vec4f(c.rgb, 1.0), c.a);
  }

  if (shape == 1u) { // one-way platform: a 4 px strip on top
    if (local.y >= 4.0) { return sky; }
    if (local.y < 1.0) { return st.edge; }
    return st.fill;
  }
  if (shape == 3u) { // ramp '/': solid below the diagonal, with an edge along it
    let surface = 15.0 - local.x;
    if (local.y < surface) { return sky; }
    if (local.y < surface + st.params.y) { return st.edge; }
    return st.fill;
  }
  if (shape == 2u) { // spikes: two teeth, pointing away from the base
    let cx = abs((local.x % 8.0) - 3.5);
    if (cx > (local.y - 4.0) * 0.4) { return sky; }
    return st.fill;
  }

  // Block: exposed sides get the edge color (a flat version of cardinal4 autotiling)
  let e = st.params.y;
  if (st.edge.a > 0.0 && e > 0.0) {
    if ((local.y < e && (mask & 1) == 0) ||
        (local.x >= 16.0 - e && (mask & 2) == 0) ||
        (local.y >= 16.0 - e && (mask & 4) == 0) ||
        (local.x < e && (mask & 8) == 0)) {
      return st.edge;
    }
  }
  return st.fill;
}
`;

/**
 * Sprite pass: instanced quads. Each instance is a world-space rectangle
 * with a color and an optional atlas region. The color tints the texture, or is
 * the whole color when uv.z (width) is 0.
 */
export const SPRITE_WGSL = /* wgsl */ `
${VIEW_STRUCT}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct Instance {
  @location(0) rect: vec4f,   // x, y, w, h in world px
  @location(1) color: vec4f,  // tint (straight alpha)
  @location(2) uv: vec4f,     // u0, v0, u1, v1 in atlas texels; u0 > u1 mirrors
};
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) textured: u32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, inst: Instance) -> VsOut {
  // Two triangles: corners (0,0) (1,0) (0,1) (0,1) (1,0) (1,1)
  var corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let c = corners[vi];
  // Snap to whole virtual pixels so sprites stay crisp against the tiles.
  let topLeft = round(inst.rect.xy) - view.cam;
  let px = topLeft + c * round(inst.rect.zw);
  var out: VsOut;
  out.pos = vec4f(px.x / view.size.x * 2.0 - 1.0, 1.0 - px.y / view.size.y * 2.0, 0.0, 1.0);
  out.color = inst.color;
  out.uv = mix(inst.uv.xy, inst.uv.zw, c);
  out.textured = select(0u, 1u, inst.uv.x != inst.uv.z);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  var c = in.color;
  if (in.textured == 1u) {
    let dims = vec2f(textureDimensions(atlas));
    c = c * textureSampleLevel(atlas, samp, in.uv / dims, 0.0);
  }
  if (c.a <= 0.0) { discard; }
  return c;
}
`;
