// WGSL source strings. They're kept in JS modules so there is no fetch or build step.

/** Fills the current viewport with a uniform color, using one fullscreen triangle. */
export const FILL_WGSL = /* wgsl */ `
struct Params { color: vec4f };
@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // (-1,-1), (3,-1), (-1,3): one triangle that covers the whole viewport.
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return params.color;
}
`;
