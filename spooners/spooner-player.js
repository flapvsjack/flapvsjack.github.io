/* spooner-player.js - plays characters made in Cutroom's Spooner Workshop (AI Studio > Workflow).
 * No server and no libraries: works in OBS, the raid page, the website and offline.
 *
 *   const puppet = await SpoonerPlayer.load(window.SPOONERS_DATA, "my-spooner", "Spooners/game/");
 *   const dressed = await SpoonerPlayer.loadOutfit(window.SPOONERS_DATA, "party-fit-x1y", "Spooners/game/");
 *   puppet.play("walk");                      // idle, walk, attack, hit, chat, cheer ... or any clip you made
 *   every frame: puppet.update(dt); puppet.draw(ctx, x, y, scale, facingLeft);
 *
 * A character is layers (your parts) in a tree: each has a pivot, a rest pose and optional spring physics
 * (hair, ears, beards swing on their own). Clips are keyframes per layer: x, y, rot, sx, sy, alpha, z and img
 * (swap the picture, e.g. eye expressions). Clips can call events (e.g. "hit" at 0.3 s) for the game.
 *
 * Moves melt into each other (play(name, {blend: seconds})), and a clip can play on top of another:
 * puppet.layer("chat") talks while it walks, puppet.unlayer("chat") stops. On a clip's "hit" moment it freezes
 * for a few frames, shakes and leaves a neon trail (clip.impact). Every copy breathes, blinks and fidgets on its
 * own timing (def.life). SpoonerPlayer.lifeOff = true turns the built-in life off everywhere.
 *
 * Dress-up: SpoonerPlayer.dress(base, items, equipped, images) puts shop items (hair, auras, companions...) onto a
 * base Spooner at its anchor points; they follow its animations and move on their own (fx: pulse, spin, bob, orbit).
 */
(function (root) {
  "use strict";
  const PROPS = ["x", "y", "rot", "sx", "sy", "alpha", "glow", "kx", "ky", "cr", "cg", "cb", "bend", "wave", "cloth", "soft"];   // bend…soft: mesh bending (L.mesh)   // glow: 0 off, 1 full · kx/ky: skew · cr/cg/cb: tint (1 = as drawn)
  const ONES = new Set(["sx", "sy", "alpha", "cr", "cg", "cb"]);
  const STEP_PROPS = ["img", "z", "vis"];                              // vis: 0 hides the part on that frame
  const EASE = {
    linear: t => t,
    ease: t => t * t * (3 - 2 * t),
    in: t => t * t,
    out: t => 1 - (1 - t) * (1 - t),
    back: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    bounce: t => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375; return n * (t -= 2.625 / d) * t + .984375; },
    step: () => 0,
  };

  function sample(keys, t, rest, step) {
    if (!keys || !keys.length) return rest;
    if (t <= keys[0].t) return keys[0].v;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (t < b.t) {
        if (step) return a.v;
        const f = (EASE[a.e] || EASE.ease)((t - a.t) / Math.max(1e-6, b.t - a.t));
        return a.v + (b.v - a.v) * f;
      }
    }
    return keys[keys.length - 1].v;
  }

  /** The pose of every layer at time t of a clip: {layerId: {x, y, rot, sx, sy, alpha, img, z}} */
  function poseAt(def, clipName, t) {
    const clip = (def.clips || {})[clipName], tracks = (clip && clip.tracks) || {}, pose = {};
    for (const L of def.layers) {
      const tr = tracks[L.id] || {}, p = {};
      for (const k of PROPS) p[k] = sample(tr[k], t, L[k] ?? (ONES.has(k) ? 1 : 0), false);
      p.img = sample(tr.img, t, L.part, true);
      p.z = sample(tr.z, t, L.z || 0, true);
      p.vis = sample(tr.vis, t, L.vis ?? 1, true);
      pose[L.id] = p;
    }
    return pose;
  }

  /** World matrices [a, b, c, d, e, f] for each layer (character space: origin at the feet, y down).
   *  Smart Limbs (def.limbs) then bend two-part limbs so their end reaches a control part (IK). */
  function fk(def, pose, spring) {
    const out = {}, byId = {};
    for (const L of def.layers) byId[L.id] = L;
    const calc = id => {
      if (out[id]) return out[id];
      const L = byId[id], p = pose[id];
      let par = L.parent && byId[L.parent] ? calc(L.parent) : [1, 0, 0, 1, 0, 0];
      if (L.inherit && L.inherit.scale === false && L.parent) {          // don't take the parent's size, only where it is and how it's turned
        const la = Math.hypot(par[0], par[1]) || 1, lb = Math.hypot(par[2], par[3]) || 1; par = [par[0] / la, par[1] / la, par[2] / lb, par[3] / lb, par[4], par[5]];
      }
      const r = p.rot + ((spring && spring[id]) ? spring[id].a : 0), c = Math.cos(r), s = Math.sin(r);
      const tx = Math.tan(p.kx || 0), ty = Math.tan(p.ky || 0);          // skew
      const m = [(c - s * ty) * p.sx, (s + c * ty) * p.sx, (c * tx - s) * p.sy, (s * tx + c) * p.sy, p.x, p.y];      // T * R * K * S
      out[id] = [par[0] * m[0] + par[2] * m[1], par[1] * m[0] + par[3] * m[1], par[0] * m[2] + par[2] * m[3], par[1] * m[2] + par[3] * m[3],
                 par[0] * m[4] + par[2] * m[5] + par[4], par[1] * m[4] + par[3] * m[5] + par[5]];
      return out[id];
    };
    for (const L of def.layers) calc(L.id);
    return out;
  }
  function world(def, pose, spring) {
    let out = fk(def, pose, spring);
    if (def.limbs && def.limbs.length) out = solveLimbs(def, pose, spring, out);
    return out;
  }

  // ---------- Smart Limbs: two-part IK (upper → lower → end) reaching for a control part
  // limb: {upper, lower, end?, tip:[x,y] (lower's far end, its own pixels × ps, when there's no end part), target, pole?,
  //        flip, stretch, max, soft, solver: "exact"|"natural", hold (0-1, natural only), endRot, on}
  const angOf = m => Math.atan2(m[1], m[0]), det = m => m[0] * m[3] - m[1] * m[2];
  const pt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  function solveLimbs(def, pose, spring, out) {
    for (const lb of def.limbs) {
      if (!lb || lb.on === false) continue;
      const pu = pose[lb.upper], pl = pose[lb.lower], pe = lb.end ? pose[lb.end] : null;
      if (!pu || !pl || !out[lb.target] || !out[lb.upper] || !out[lb.lower]) continue;
      for (const p of [pu, pl, pe]) if (p) { if (p._ik) Object.assign(p, p._ik); else p._ik = { rot: p.rot, sx: p.sx, sy: p.sy }; }   // same answer however often it's asked
      out = fk(def, pose, spring);
      const endW = () => lb.end && out[lb.end] ? [out[lb.end][4], out[lb.end][5]] : pt(out[lb.lower], (lb.tip || [0, 0])[0], (lb.tip || [0, 0])[1]);
      let A = [out[lb.upper][4], out[lb.upper][5]], B = [out[lb.lower][4], out[lb.lower][5]], E = endW();
      const T = [out[lb.target][4], out[lb.target][5]];
      let L1 = Math.hypot(B[0] - A[0], B[1] - A[1]), L2 = Math.hypot(E[0] - B[0], E[1] - B[1]);
      if (L1 < 1e-3 || L2 < 1e-3) continue;
      let d = Math.hypot(T[0] - A[0], T[1] - A[1]);
      // stretch: both parts get longer when the target is out of reach
      if (lb.stretch && d > L1 + L2) {
        const k = Math.min(Math.max(1, +lb.max || 1.5), d / (L1 + L2));
        pu[lb.axisU || "sx"] *= k;                                    // the lower part inherits the stretch (it's straight when this happens)
        out = fk(def, pose, spring); A = [out[lb.upper][4], out[lb.upper][5]]; B = [out[lb.lower][4], out[lb.lower][5]]; E = endW();
        L1 = Math.hypot(B[0] - A[0], B[1] - A[1]); L2 = Math.hypot(E[0] - B[0], E[1] - B[1]);
      }
      const Lt = L1 + L2, soft = Math.max(0, +lb.soft || 0) * Lt * .25;
      if (soft > 0 && d > Lt - soft) d = (Lt - soft) + soft * (1 - Math.exp(-(d - (Lt - soft)) / soft));   // ease into full reach instead of snapping straight
      d = Math.max(Math.abs(L1 - L2) + 1e-3, Math.min(Lt - 1e-4, d));
      // which way the joint bends: as drawn (or flipped), or towards the pole
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      let side = Math.sign(cr(A, B, E)) || 1;
      if (lb.pole && out[lb.pole]) { const P = [out[lb.pole][4], out[lb.pole][5]], ps = Math.sign(cr(A, T, P)); if (ps) side = -ps; }
      if (lb.flip) side = -side;
      const phi = Math.atan2(T[1] - A[1], T[0] - A[0]), cosA = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
      let thU = phi - side * Math.acos(cosA);
      const fkU = Math.atan2(B[1] - A[1], B[0] - A[0]);
      if (lb.solver === "natural") thU = fkU + wrap(thU - fkU) * (1 - Math.max(0, Math.min(1, +lb.hold || 0)));   // upper part keeps some of its own swing
      // turn the upper part, then aim the lower part at the target
      const sU = det(out[lb.upper]) < 0 ? -1 : 1;
      pu.rot += sU * wrap(thU - fkU);
      out = fk(def, pose, spring);
      const B1 = [out[lb.lower][4], out[lb.lower][5]], E1 = endW();
      const sL = det(out[lb.lower]) < 0 ? -1 : 1;
      pl.rot += sL * wrap(Math.atan2(T[1] - B1[1], T[0] - B1[0]) - Math.atan2(E1[1] - B1[1], E1[0] - B1[0]));
      out = fk(def, pose, spring);
      // the end part (hand / foot / head) can turn with the control
      if (pe && lb.endRot && out[lb.end]) { const sE = det(out[lb.end]) < 0 ? -1 : 1; pe.rot += sE * wrap(angOf(out[lb.target]) - angOf(out[lb.end])); out = fk(def, pose, spring); }
    }
    return out;
  }

  /** Draw a pose. images: {partId: HTMLImageElement}. opts: {alpha, only, tint} */
  function drawPose(ctx, def, pose, images, parts, x, y, scale, flip, spring, opts) {
    opts = opts || {};
    const W = world(def, pose, spring);
    const order = def.layers.slice().sort((a, b) => (pose[a.id].z - pose[b.id].z) || (def.layers.indexOf(a) - def.layers.indexOf(b)));
    const skin = skinMap(def, opts.skin ?? def.skin), byId = {}; for (const L of def.layers) byId[L.id] = L;
    // opacity and tint passed down to attached parts when a part asks for it (inherit)
    const eff = {}, effOf = id => {
      if (eff[id]) return eff[id];
      const L = byId[id], p = pose[id], par = L.parent && byId[L.parent] ? effOf(L.parent) : null, inh = L.inherit || {};
      return (eff[id] = { a: p.alpha * (par && inh.opacity ? par.a : 1), r: p.cr * (par && inh.tint ? par.r : 1), g: p.cg * (par && inh.tint ? par.g : 1), b: p.cb * (par && inh.tint ? par.b : 1) });
    };
    ctx.save();
    ctx.translate(x, y); ctx.scale(flip ? -scale : scale, scale);
    const base = ctx.getTransform(), pix = !!def.pixel, ghost = opts.ghost ? ghostFilter(opts.ghost) : "";
    if (ghost) ctx.globalCompositeOperation = "lighter";
    if (pix) ctx.imageSmoothingEnabled = false;
    for (const L of order) {
      const p = pose[L.id], pid = (skin && skin[p.img]) || p.img, img = images[pid];
      const iw = img && (img.naturalWidth || img.width), ih = img && (img.naturalHeight || img.height);
      if (!img || img.complete === false || !iw || L.hidden || p.vis === 0) continue;
      if (opts.only && !opts.only.has(L.id)) continue;
      const e = effOf(L.id); if (e.a <= 0) continue;
      const m = W[L.id], ps = L.ps || 1;
      ctx.setTransform(base); ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      if (pix) { const T = ctx.getTransform(); T.e = Math.round(T.e); T.f = Math.round(T.f); ctx.setTransform(T); }   // whole pixels only
      if (L.mirror && (L.mirror.x || L.mirror.y)) ctx.scale(L.mirror.x ? -1 : 1, L.mirror.y ? -1 : 1);                    // flip the picture, not what's attached
      ctx.globalAlpha = e.a * (opts.alpha ?? 1);
      const lk = L.look || {}, g = Math.max(0, Math.min(1.5, +p.glow || 0));
      let src = tinted(img, lk, iw, ih);
      if (e.r < .999 || e.g < .999 || e.b < .999) src = multiplied(src, e.r, e.g, e.b, iw, ih);
      if (L.mask && W[L.mask] && byId[L.mask]) src = masked(src, L, byId[L.mask], pose[L.mask], W, images, skin, iw, ih) || src;
      let dx = -(L.px || 0) * ps, dy = -(L.py || 0) * ps, dw = iw * ps, dh = ih * ps;
      if (L.mesh && L.mesh.on) { const mc = meshed(src, L, p, iw, ih, +opts.time || 0, W, def); if (mc) { src = mc.c; dx = -((L.px || 0) + mc.m) * ps; dy = -((L.py || 0) + mc.m) * ps; dw = mc.c.width * ps; dh = mc.c.height * ps; } }
      const bright = (lk.bright ?? 1) * (1 + .35 * g);
      ctx.filter = ghost || ((lk.hue || (lk.sat ?? 1) !== 1 || bright !== 1) ? `hue-rotate(${lk.hue || 0}deg) saturate(${lk.sat ?? 1}) brightness(${bright.toFixed(3)})` : "none");
      if (g > 0 && !ghost) {                                                       // glow: a coloured halo, twice when strong
        const sc = Math.hypot(m[0], m[1]) * Math.abs(scale);
        ctx.shadowColor = lk.glowColor || "#37e8ff"; ctx.shadowBlur = Math.max(1, (lk.glowSize ?? 18) * g * sc);
        ctx.drawImage(src, dx, dy, dw, dh);
        if (g > .5) ctx.drawImage(src, dx, dy, dw, dh);
        ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
      } else ctx.drawImage(src, dx, dy, dw, dh);
      ctx.filter = "none";
    }
    ctx.restore();
    return W;
  }
  // ---------- mesh bending: the picture becomes a grid of triangles that bend, wave, sway like cloth, jiggle or get pulled
  // L.mesh = {on, grid, axis: "auto"|"up"|"down"|"left"|"right", bend: {on}, wave: {on, count, speed, root}, cloth: {on, speed, top},
  //           soft: {on, speed}, pull: {on, ctl, ax, ay, r}}; strengths are keyable props: bend (radians), wave, cloth, soft (0-2)
  const MESHES = new Map();
  function meshAxis(L, iw, ih) {                                        // from the pivot to the far end of the picture
    const px = L.px || 0, py = L.py || 0, a = (L.mesh && L.mesh.axis) || "auto";
    const ends = { up: [px, 0], down: [px, ih], left: [0, py], right: [iw, py] };
    let e = ends[a];
    if (!e) e = Object.values(ends).sort((p, q) => Math.hypot(q[0] - px, q[1] - py) - Math.hypot(p[0] - px, p[1] - py))[0];
    const dx = e[0] - px, dy = e[1] - py, len = Math.max(1, Math.hypot(dx, dy));
    return { ux: dx / len, uy: dy / len, len };
  }
  function meshed(src, L, p, iw, ih, t, W, def) {
    const M = L.mesh, n = Math.max(2, Math.min(24, M.grid | 0 || 10)), px = L.px || 0, py = L.py || 0;
    const bend = M.bend && M.bend.on ? (+p.bend || 0) : 0, wave = M.wave && M.wave.on ? (+p.wave || 0) : 0, cloth = M.cloth && M.cloth.on ? (+p.cloth || 0) : 0, soft = M.soft && M.soft.on ? (+p.soft || 0) : 0;
    let pull = null;
    if (M.pull && M.pull.on && M.pull.ctl && W[M.pull.ctl] && W[L.id]) {   // where the pull control is, in this picture's pixels
      const m = W[L.id], ps = L.ps || 1, d = m[0] * m[3] - m[1] * m[2] || 1e-9, cx = W[M.pull.ctl][4] - m[4], cy = W[M.pull.ctl][5] - m[5];
      const lx = (m[3] * cx - m[2] * cy) / d, ly = (-m[1] * cx + m[0] * cy) / d; pull = { dx: lx / ps + px - M.pull.ax, dy: ly / ps + py - M.pull.ay, ax: M.pull.ax, ay: M.pull.ay, r: Math.max(5, +M.pull.r || Math.max(iw, ih) * .5) };
    }
    if (!bend && !wave && !cloth && !soft && !(pull && (pull.dx || pull.dy))) return null;
    const ax = meshAxis(L, iw, ih), nx = -ax.uy, ny = ax.ux, Lx = ax.len;
    const V = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const u = iw * i / n, v = ih * j / n;
      let a = (u - px) * ax.ux + (v - py) * ax.uy, b = (u - px) * nx + (v - py) * ny;   // along the picture / across it
      let A = a, B = b;
      if (bend && a > 0) { const k = bend / Lx, f = k * a; A = Math.sin(f) / k - b * Math.sin(f); B = (1 - Math.cos(f)) / k + b * Math.cos(f); }
      const s = Math.max(0, Math.min(1, a / Lx));
      if (wave) { const cnt = +(M.wave.count || 1.5), sp = +(M.wave.speed || 1), dir = M.wave.root ? -1 : 1; B += Math.sin(2 * Math.PI * (cnt * s - dir * sp * t)) * Lx * .06 * wave * s; }
      let x = px + A * ax.ux + B * nx, y = py + A * ax.uy + B * ny;
      if (cloth) { const top = Math.max(0, Math.min(.9, +(M.cloth.top ?? .1))), w = Math.max(0, (v / ih - top) / (1 - top)), sp = +(M.cloth.speed || 1);
        x += Math.pow(w, 1.6) * ih * .07 * cloth * Math.sin(2 * Math.PI * (sp * t - v / ih * .8)); y -= Math.pow(w, 2) * ih * .015 * cloth * (1 + Math.sin(2 * Math.PI * sp * t * 2)); }
      if (soft) { const sp = +(M.soft.speed || 1), q = Math.sin(2 * Math.PI * sp * t * 1.5) * .05 * soft, dd = Math.min(1, Math.hypot(x - px, y - py) / Math.max(iw, ih)); x = px + (x - px) * (1 + q * dd); y = py + (y - py) * (1 - q * dd); }
      if (pull) { const d = Math.hypot(u - pull.ax, v - pull.ay) / pull.r, f = d >= 1 ? 0 : (1 - d * d) * (1 - d * d); x += pull.dx * f; y += pull.dy * f; }
      V.push([u, v, x, y]);
    }
    const m = Math.ceil(Math.max(iw, ih) * .6);
    let k = MESHES.get(L.id); if (!k) { k = document.createElement("canvas"); MESHES.set(L.id, k); }
    if (k.width !== iw + 2 * m) k.width = iw + 2 * m; if (k.height !== ih + 2 * m) k.height = ih + 2 * m;
    const c = k.getContext("2d"); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, k.width, k.height);
    const tri = (p0, p1, p2) => {                                         // copy one triangle of the picture to its bent place
      const [u0, v0, x0, y0] = p0, [u1, v1, x1, y1] = p1, [u2, v2, x2, y2] = p2;
      const den = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0); if (Math.abs(den) < 1e-6) return;
      const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / den, cc = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / den;
      const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / den, d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / den;
      const e = x0 - a * u0 - cc * v0, f = y0 - b * u0 - d * v0;
      const gx = (x0 + x1 + x2) / 3, gy = (y0 + y1 + y2) / 3, grow = (X, Y) => { const dx = X - gx, dy = Y - gy, l = Math.hypot(dx, dy) || 1; return [X + dx / l * .7 + m, Y + dy / l * .7 + m]; };   // a hair bigger: no seams
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.beginPath(); const q0 = grow(x0, y0), q1 = grow(x1, y1), q2 = grow(x2, y2); c.moveTo(q0[0], q0[1]); c.lineTo(q1[0], q1[1]); c.lineTo(q2[0], q2[1]); c.closePath(); c.clip();
      c.setTransform(a, b, cc, d, e + m, f + m); c.drawImage(src, 0, 0, iw, ih); c.restore();
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const q = j * (n + 1) + i, a0 = V[q], a1 = V[q + 1], a2 = V[q + n + 1], a3 = V[q + n + 2]; tri(a0, a1, a3); tri(a0, a3, a2); }
    return { c: k, m, V };
  }
  /** Skins: each one swaps some pictures for its own ({fromPart: toPart}); pictures it doesn't swap stay as the default skin. */
  function skinMap(def, name) { if (!name || !def.skins) return null; const s = def.skins.find(k => k.name === name || k.id === name); return s ? s.swap || null : null; }
  // a picture multiplied by a colour (keyable tint), cached per picture and colour
  const MULTS = new WeakMap();
  function multiplied(img, r, g, b, iw, ih) {
    let byKey = MULTS.get(img); if (!byKey) { byKey = new Map(); MULTS.set(img, byKey); }
    const q = v => Math.round(Math.max(0, Math.min(1, v)) * 48), key = q(r) + "," + q(g) + "," + q(b); let c = byKey.get(key);
    if (!c) {
      c = document.createElement("canvas"); c.width = iw; c.height = ih; const x = c.getContext("2d");
      x.drawImage(img, 0, 0); x.globalCompositeOperation = "multiply"; x.fillStyle = `rgb(${q(r) / 48 * 255},${q(g) / 48 * 255},${q(b) / 48 * 255})`; x.fillRect(0, 0, iw, ih);
      x.globalCompositeOperation = "destination-in"; x.drawImage(img, 0, 0);
      if (byKey.size > 48) byKey.clear(); byKey.set(key, c);
    }
    return c;
  }
  // a part cut to another part's shape (mask), with padding: drawn fresh each frame in the part's own pixels
  const MASKS = new Map();
  function masked(src, L, M, pm, W, images, skin, iw, ih) {
    const mid = (skin && skin[pm.img]) || pm.img, mi = images[mid]; if (!mi || !mi.naturalWidth || pm.vis === 0) return null;
    let k = MASKS.get(L.id); if (!k) { k = { a: document.createElement("canvas"), b: document.createElement("canvas") }; MASKS.set(L.id, k); }
    for (const c of [k.a, k.b]) { if (c.width !== iw) c.width = iw; if (c.height !== ih) c.height = ih; }
    const A = (Ly) => { const ps = Ly.ps || 1; return [ps, 0, 0, ps, -(Ly.px || 0) * ps, -(Ly.py || 0) * ps]; };
    const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    const inv = m => { const d = m[0] * m[3] - m[1] * m[2] || 1e-9; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };
    const R = mul(inv(mul(W[L.id], A(L))), mul(W[M.id], A(M)));        // mask pixels → this part's pixels
    const mx = k.b.getContext("2d"); mx.setTransform(1, 0, 0, 1, 0, 0); mx.clearRect(0, 0, iw, ih); mx.setTransform(R[0], R[1], R[2], R[3], R[4], R[5]);
    const pad = Math.max(0, +L.maskPad || 0), steps = pad > 0 ? 12 : 1;
    for (let i = 0; i < steps; i++) { const a = i / steps * Math.PI * 2, dx = pad > 0 ? Math.cos(a) * pad : 0, dy = pad > 0 ? Math.sin(a) * pad : 0; mx.drawImage(mi, dx, dy); }
    if (pad > 0) mx.drawImage(mi, 0, 0);
    const ox = k.a.getContext("2d"); ox.setTransform(1, 0, 0, 1, 0, 0); ox.globalCompositeOperation = "source-over"; ox.clearRect(0, 0, iw, ih); ox.drawImage(src, 0, 0, iw, ih);
    ox.globalCompositeOperation = "destination-in"; ox.drawImage(k.b, 0, 0); ox.globalCompositeOperation = "source-over";
    return k.a;
  }
  // a part's picture washed with a colour (look.tint + look.tintAmt), cached per picture and colour
  const TINTS = new WeakMap();
  function tinted(img, lk, iw, ih) {
    const amt = +lk.tintAmt || 0; if (!lk.tint || amt <= 0) return img;
    let byKey = TINTS.get(img); if (!byKey) { byKey = new Map(); TINTS.set(img, byKey); }
    const key = lk.tint + "|" + amt.toFixed(2); let c = byKey.get(key);
    if (!c) {
      c = document.createElement("canvas"); c.width = iw; c.height = ih; const x = c.getContext("2d");
      x.drawImage(img, 0, 0); x.globalCompositeOperation = "source-atop"; x.globalAlpha = Math.min(1, amt); x.fillStyle = lk.tint; x.fillRect(0, 0, iw, ih);
      if (byKey.size > 24) byKey.clear(); byKey.set(key, c);
    }
    return c;
  }

  /* ---------- 1. clips melt into each other, and clips can play on top of each other ---------- */
  const clonePose = pose => { const o = {}; for (const k in pose) o[k] = Object.assign({}, pose[k]); return o; };
  const lerpAng = (a, b, k) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * k; };
  function applyBlend(p, dt) {                                       // the pose you were in fades into the new clip
    const b = p.blend; if (!b) return;
    b.t += dt; const k = Math.min(1, b.t / b.d), e = k * k * (3 - 2 * k); b.k = e;
    if (k >= 1) { p.blend = null; return; }
    for (const L of p.def.layers) {
      const a = b.from[L.id], c = p.pose[L.id]; if (!a || !c) continue;
      for (const prop of PROPS) if (a[prop] !== undefined && c[prop] !== undefined) c[prop] = prop === "rot" ? lerpAng(a[prop], c[prop], e) : a[prop] + (c[prop] - a[prop]) * e;
      if (e < .5) { c.z = a.z; c.vis = a.vis; }
      if (a.img !== c.img) b.swap = true;                              // a different picture: cross-fade the two when drawing
    }
  }
  function applyOverlays(p, dt) {                                    // e.g. talk on top of walk: the overlay adds its motion
    if (!p.overlays.length) return;
    for (const o of p.overlays.slice()) {
      const clip = (p.def.clips || {})[o.clip]; if (!clip) { p.overlays.splice(p.overlays.indexOf(o), 1); continue; }
      o.w += Math.sign(o.target - o.w) * Math.min(Math.abs(o.target - o.w), dt / Math.max(.01, o.fade));
      o.t += dt;
      if (o.t >= clip.len) { if (clip.loop !== false || o.loop) o.t %= Math.max(.01, clip.len); else { o.t = clip.len; o.target = 0; } }
      if (o.w <= .001 && o.target === 0) { p.overlays.splice(p.overlays.indexOf(o), 1); continue; }
      const O = poseAt(p.def, o.clip, o.t), tracks = clip.tracks || {};
      for (const L of p.def.layers) {
        const tr = tracks[L.id]; if (!tr) continue; const c = p.pose[L.id], q = O[L.id];
        for (const k of PROPS) {
          if (!tr[k] || !tr[k].length) continue;
          const rest = L[k] ?? (ONES.has(k) ? 1 : 0);
          if (ONES.has(k)) c[k] *= Math.pow(Math.max(.001, q[k]) / (rest || 1), o.w); else c[k] += (q[k] - rest) * o.w;
        }
        if (tr.img && tr.img.length && o.w > .5 && !p.def.baked) c.img = q.img;
      }
    }
  }

  /* ---------- 3. impact: on a clip's "hit" moment it freezes for a few frames, shakes, and fast swings leave a neon trail ---------- */
  const ATTACKY = /^(attack\d*|slash|punch|slam|shoot|bite|lunge|whip|grenade|throw|kick|lasers|rocks|spread|strike)/i;
  function impactOf(clip, name) {
    if (clip && clip.impact) return clip.impact;
    return clip && clip.loop === false && ATTACKY.test(name || "") ? { stop: 60, shake: 3, trail: 1 } : null;
  }
  function hitTime(clip) { const h = (clip.events || []).find(e => e.name === "hit"); return h ? h.t : (clip.len || 1) * .5; }
  function stepTrail(p, dt) {
    const clip = (p.def.clips || {})[p.clip], im = impactOf(clip, p.clip), tr = p.trail || (p.trail = { snaps: [], acc: 0 });
    const on = im && im.trail && clip && p.t >= hitTime(clip) - .2 && p.t <= hitTime(clip) + .06;
    tr.acc += dt;
    if (tr.acc < 1 / 60) return; tr.acc = 0;
    if (on) { tr.snaps.push(clonePose(p.pose)); tr.color = im.color || "#37e8ff"; while (tr.snaps.length > (im.trail >= 2 ? 7 : 4)) tr.snaps.shift(); }
    else if (tr.snaps.length) tr.snaps.shift();                       // the tail fades out after the swing
  }
  function ghostFilter(hex) {                                         // a picture recoloured to one glowing neon colour
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); let h = 189;
    if (m) { const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn || 1e-6;
      h = (mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60; }
    return `brightness(.55) sepia(1) saturate(8) hue-rotate(${Math.round(h - 38)}deg) brightness(1.7)`;
  }

  /* ---------- 6. built-in life: breathing, blinking, idle variety; every copy of a character on its own timing ---------- */
  const IDLEY = /^(idle|chat|talk|cheer|_hold)/i;
  function lifeOf(def) {
    const L = def.life || {};
    return { breathe: L.breathe ?? .5, blink: L.blink !== false, desync: L.desync !== false,
      idle: { on: !!(L.idle && L.idle.on), every: (L.idle && L.idle.every) || [6, 14], clips: (L.idle && L.idle.clips) || [], glance: !L.idle || L.idle.glance !== false },
      eyes: L.eyes || null, eyeR: L.eyeR || 0, lid: L.lid || "" };
  }
  function applyLife(p, dt) {
    const lf = p.life; if (!lf || root.SpoonerPlayer.lifeOff || p.lifeOff) return;
    const clip = (p.def.clips || {})[p.clip], idleish = clip && clip.loop !== false && IDLEY.test(p.clip || ""), loopy = clip && clip.loop !== false;
    const R = p.rootLayer, pr = R && p.pose[R.id];
    // breathing: the body gently swells and settles (less while moving, none during one-shot moves)
    p.breW += ((idleish ? 1 : loopy ? .35 : 0) - p.breW) * Math.min(1, dt * 3);
    if (pr && lf.breathe > 0 && p.breW > .01) {
      const s = Math.sin(p.age * 2 * Math.PI / p.rnd.breath + p.rnd.phase), a = .02 * lf.breathe * p.breW;
      pr.sy *= 1 + a * s; pr.sx *= 1 - a * .45 * s;
    }
    // idle variety: now and then, a move of its own (your clips) or a small glance
    if (lf.idle.on && idleish && p.clip !== "_hold") {
      if (p.age >= p.nextVar) {
        p.nextVar = p.age + lf.idle.every[0] + Math.random() * Math.max(0, lf.idle.every[1] - lf.idle.every[0]);
        const opts = lf.idle.clips.filter(n => p.has(n));
        if (opts.length && (!lf.idle.glance || Math.random() < .7)) p.play(opts[Math.floor(Math.random() * opts.length)], { restart: true, then: p.clip });
        else if (lf.idle.glance) p.glance = { t: 0, d: 1.6 + Math.random() * .8, dir: Math.random() < .5 ? -1 : 1 };
      }
    } else if (p.age >= p.nextVar) p.nextVar = p.age + 3;
    if (p.glance && pr) {
      const g = p.glance; g.t += dt; const k = g.t / g.d; if (k >= 1) p.glance = null;
      else { const w = Math.sin(Math.min(1, k) * Math.PI); pr.rot += g.dir * .06 * w * (1 - Math.abs(.5 - k)); pr.y -= 2 * w; }
    }
    // blinking: a quick close and open every few seconds, sometimes twice
    if (lf.blink && p.eyesOk) {
      if (p.blinkT == null && p.age >= p.nextBlink) { p.blinkT = 0; p.nextBlink = p.age + 2.2 + Math.random() * 4; if (Math.random() < .18) p.dbl = true; }
      if (p.blinkT != null) { p.blinkT += dt; if (p.blinkT > .16) { p.blinkT = null; if (p.dbl) { p.dbl = false; p.nextBlink = p.age + .12; } } }
    }
  }
  // talking: the mouth / jaw / visor opens with how loud the voice is (puppet.talk(0..1) every frame while it speaks)
  function applyTalk(p, dt) {
    if (p.talkAt != null && p.age - p.talkAt > .25) p.talkLv = 0;
    p.talkS = (p.talkS || 0) + ((p.talkLv || 0) - (p.talkS || 0)) * Math.min(1, dt * 18); const lv = p.talkS; if (lv < .01) return;
    if (!p.mouths) p.mouths = p.def.layers.filter(L => (p.def.life && p.def.life.mouth || []).includes(L.id) || /mouth|jaw|visor|lip/i.test(L.name || L.id));
    if (p.mouths.length) for (const L of p.mouths) { const c = p.pose[L.id]; if (!c) continue; if (/jaw/i.test(L.name || L.id)) c.rot += .45 * lv; else c.sy *= 1 + .9 * lv; }
    else { const c = p.rootLayer && p.pose[p.rootLayer.id]; if (c) { c.sy *= 1 + .05 * lv; c.sx *= 1 - .02 * lv; } }   // one picture: a little talking bob
  }
  function eyesNow(p) {                                               // where the eyes are on this frame (character space, feet = 0,0)
    const lf = p.life, clip = (p.def.clips || {})[p.clip];
    if (clip && clip.eyes && clip.eyes.pts && clip.eyes.pts.length) { const f = Math.min(clip.eyes.pts.length - 1, Math.max(0, Math.floor(p.t * (clip.eyes.fps || 30)))); return clip.eyes.pts[f]; }
    return lf.eyes;
  }
  function drawBlink(p, ctx, x, y, scale, flip) {
    if (p.blinkT == null || !ctx.getImageData) return;
    const pts = eyesNow(p), R0 = p.life.eyeR; if (!pts || !pts.length || !R0) return;
    const k = 1 - Math.sin(Math.min(1, p.blinkT / .16) * Math.PI) * .9;           // 1 = open, .1 = shut
    try {
      const T = ctx.getTransform(), sc = Math.hypot(T.a, T.b);
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const e of pts) {
        const lx = x + (flip ? -1 : 1) * e[0] * scale, ly = y + e[1] * scale;
        const X = T.a * lx + T.c * ly + T.e, Y = T.b * lx + T.d * ly + T.f, R = Math.max(2, R0 * scale * sc);
        const s = ctx.getImageData(Math.round(X), Math.round(Y - R * 1.35), 1, 1).data;
        if (s[3] < 60) continue;                                                     // nothing above the eye to close it with
        const c = p._eyeC || (p._eyeC = document.createElement("canvas")), n = Math.ceil(R * 2);
        if (c.width !== n) { c.width = n; c.height = n; }
        const g = c.getContext("2d"); g.clearRect(0, 0, n, n); g.drawImage(ctx.canvas, X - R, Y - R, n, n, 0, 0, n, n);
        ctx.fillStyle = p.life.lid || `rgb(${s[0]},${s[1]},${s[2]})`;
        ctx.beginPath(); ctx.ellipse(X, Y, R * 1.02, R * 1.02, 0, 0, Math.PI * 2); ctx.fill();
        ctx.drawImage(c, X - R, Y - R * k, n, n * k);
      }
      ctx.restore();
    } catch (err) { p.eyesOk = false; }                                             // a picture from another site: no blinking
  }

  class Puppet {
    constructor(def, images, parts) {
      this.def = def; this.images = images; this.parts = parts || {};
      this.clip = null; this.t = 0; this.age = 0; this.speed = 1; this.queue = null; this.listeners = [];
      this.spring = {}; this.prev = {};
      for (const L of def.layers) if (L.spring && L.spring.on) this.spring[L.id] = { a: 0, v: 0 };
      this.overlays = []; this.blend = null; this.freeze = 0; this.shake = null; this.breW = 0;
      this.life = lifeOf(def); this.rootLayer = def.layers.find(L => !L.parent) || def.layers[0];
      this.rnd = { breath: 3.4 + Math.random() * 1.6, phase: Math.random() * 6.28, tempo: .92 + Math.random() * .16 };
      this.nextVar = 2 + Math.random() * 8; this.nextBlink = .5 + Math.random() * 3; this.blinkT = null;
      this.eyesOk = !!(this.life.eyeR && (this.life.eyes || Object.values(def.clips || {}).some(c => c.eyes)));
      this.play((def.clips || {}).idle ? "idle" : Object.keys(def.clips || {})[0], { blend: 0 });
      const c0 = (def.clips || {})[this.clip];
      if (c0 && c0.loop !== false && this.life.desync) this.t = Math.random() * (c0.len || 1);   // a crowd doesn't move in step
    }
    has(name) { return !!(this.def.clips || {})[name]; }
    /** play a clip; a non-looping clip goes back to "then" (default idle) when it ends */
    play(name, opts) {
      opts = opts || {};
      if (!this.has(name)) return false;
      if (this.clip === name && !opts.restart) return true;
      const d = opts.blend ?? (this.def.blend ?? .15);
      if (this.pose && this.clip && d > 0) this.blend = { from: clonePose(this.pose), t: 0, d, k: 0 };
      this.clip = name; this.t = 0; this.then = opts.then || "idle"; this.fired = new Set(); this.glance = null;
      return true;
    }
    /** play a clip on top of the current one (its motion is added): layer("chat") while walking */
    layer(name, opts) {
      if (!this.has(name)) return false; opts = opts || {};
      let o = this.overlays.find(x => x.clip === name);
      if (!o) { o = { clip: name, t: 0, w: 0 }; this.overlays.push(o); }
      o.target = opts.weight ?? 1; o.fade = opts.fade ?? .2; o.loop = !!opts.loop; return true;
    }
    unlayer(name) { for (const o of this.overlays) if (!name || o.clip === name) o.target = 0; }
    /** how loud it is talking right now, 0..1 (call every frame while a voice plays) */
    talk(level) { this.talkLv = Math.max(0, Math.min(1, +level || 0)); this.talkAt = this.age || 0; }
    on(fn) { this.listeners.push(fn); }
    update(dt) {
      this.age = (this.age || 0) + (dt || 0);
      if (this.shake) { this.shake.t -= dt; if (this.shake.t <= 0) this.shake = null; }
      if (this.freeze > 0) { this.freeze -= dt; fxStep(this, dt); return; }        // hit-stop: everything holds for a moment
      const clip = (this.def.clips || {})[this.clip];
      if (clip) {
        this.t += dt * this.speed * (this.life.desync && clip.loop !== false && IDLEY.test(this.clip) ? this.rnd.tempo : 1);
        for (const ev of clip.events || []) if (this.t >= ev.t && !this.fired.has(ev)) {
          this.fired.add(ev);
          if (ev.name === "hit") { const im = impactOf(clip, this.clip);
            if (im) { if (im.stop && this.selfStop !== false) this.freeze = im.stop / 1000; if (im.shake) this.shake = { amp: im.shake, t: .28, d: .28 }; } }
          this.listeners.forEach(f => f(ev.name, this.clip));
        }
        if (this.t >= clip.len) {
          if (clip.loop !== false) { this.t %= Math.max(.01, clip.len); this.fired = new Set(); }
          else { this.listeners.forEach(f => f("end", this.clip)); if (!this.play(this.then)) this.t = clip.len; }
        }
      }
      this.age += dt;
      this.pose = poseAt(this.def, this.clip, this.t);
      applyOverlays(this, dt);
      applyFx(this.def, this.pose, this.age);
      applyLife(this, dt);
      applyTalk(this, dt);
      applyBlend(this, dt);
      stepSprings(this, dt);
      stepTrail(this, dt);
      fxStep(this, dt);
    }
    draw(ctx, x, y, scale, flip, opts) {
      if (!this.pose) this.pose = poseAt(this.def, this.clip, this.t);
      this.lastXY = [x, y, scale || 1, flip];
      if (this.shake) { const a = this.shake.amp * (this.shake.t / this.shake.d) * (scale || 1); x += (Math.random() * 2 - 1) * a; y += (Math.random() * 2 - 1) * a * .6; }
      fxDraw(this, ctx, x, y, scale || 1, flip, true);
      const base = Object.assign({ skin: this.skin || undefined, time: this.age || 0 }, opts);
      const tr = this.trail;
      if (tr && tr.snaps.length) tr.snaps.forEach((sn, i) => drawPose(ctx, this.def, sn, this.images, this.parts, x, y, scale || 1, flip, this.spring,
        Object.assign({}, base, { alpha: (base.alpha ?? 1) * .8 * (i + 1) / (tr.snaps.length + 1), ghost: tr.color })));
      let W;
      if (this.blend && this.blend.swap) {                            // two different pictures: the old one fades as the new one comes in
        const k = this.blend.k || 0;
        drawPose(ctx, this.def, this.blend.from, this.images, this.parts, x, y, scale || 1, flip, this.spring, Object.assign({}, base, { alpha: (base.alpha ?? 1) * (1 - k) }));
        W = drawPose(ctx, this.def, this.pose, this.images, this.parts, x, y, scale || 1, flip, this.spring, Object.assign({}, base, { alpha: (base.alpha ?? 1) * Math.sqrt(k) }));
      } else W = drawPose(ctx, this.def, this.pose, this.images, this.parts, x, y, scale || 1, flip, this.spring, base);
      if (this.eyesOk && !base.ghost) drawBlink(this, ctx, x, y, scale || 1, flip);
      fxDraw(this, ctx, x, y, scale || 1, flip, false);
      return W;
    }
    /** a one-shot burst of an effect (hit sparks, shockwave...) at a layer, e.g. puppet.burst("hit-burst") */
    burst(ref, layer, x, y, count) {
      const d = fxOf(ref); if (!d) return false;
      if (!this.pose) this.pose = poseAt(this.def, this.clip, this.t);
      const fx = this.fxs || (this.fxs = { ps: [], acc: [] }), at = fxAnchor(world(this.def, this.pose, this.spring), this.def, { layer, x, y }); if (!at) return false;
      fxSpawn(fx, d, at[0], at[1], at[2], count || d.burst || 24, true); return true;   // bursts (hits, wins) always play in front
    }
  }
  /* ---------------- effects: particles that follow a layer (sparkles, fire, frost, hearts, shockwaves...)
     An effect is plain data: {id, name, shape, colors, blend, rate, burst, life:[a,b], speed:[a,b], angle, spread, gravity, drag,
     size:[start,end], alpha:[start,end], radius, spin, behind}. Characters list them in def.effects = [{fx: id or effect, layer, x, y}];
     shop items with an "fx" add one where they attach. Workflow › ⑦ Effects makes them; the export ships them as data.effects. */
  const FXLIB = {};
  function registerEffects(list) { for (const e of list || []) if (e && e.id) FXLIB[e.id] = e; }
  const fxOf = ref => (ref && typeof ref === "object" ? ref : FXLIB[ref]) || null;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pair = (v, d) => Array.isArray(v) ? [+v[0] || 0, +(v[1] ?? v[0]) || 0] : [v ?? d, v ?? d];
  const SPRITES = new Map();
  function sprite(shape, color) {                                    // one small picture per shape and colour, drawn scaled
    const key = shape + "|" + color; let c = SPRITES.get(key); if (c) return c;
    if (typeof document === "undefined") return null;
    c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d"), m = 32;
    x.fillStyle = x.strokeStyle = color;
    if (shape === "dot" || shape === "smoke") { const g = x.createRadialGradient(m, m, 0, m, m, m); g.addColorStop(0, color); g.addColorStop(shape === "smoke" ? .2 : .35, color); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.globalAlpha = shape === "smoke" ? .55 : 1; x.fillRect(0, 0, 64, 64); }
    else if (shape === "star") { x.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 12 : 30, a = -Math.PI / 2 + i * Math.PI / 5; x.lineTo(m + Math.cos(a) * r, m + Math.sin(a) * r); } x.closePath(); x.shadowColor = color; x.shadowBlur = 8; x.fill(); }
    else if (shape === "spark") { x.beginPath(); x.moveTo(2, m); x.lineTo(m, m - 6); x.lineTo(62, m); x.lineTo(m, m + 6); x.closePath(); x.shadowColor = color; x.shadowBlur = 6; x.fill(); }
    else if (shape === "ring") { x.lineWidth = 5; x.beginPath(); x.arc(m, m, 27, 0, Math.PI * 2); x.shadowColor = color; x.shadowBlur = 6; x.stroke(); }
    else if (shape === "heart") { x.beginPath(); x.moveTo(m, 54); x.bezierCurveTo(4, 34, 10, 6, m, 20); x.bezierCurveTo(54, 6, 60, 34, m, 54); x.fill(); }
    else if (shape === "square") { x.fillRect(16, 22, 32, 20); }
    else if (shape === "note") { x.font = "bold 48px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("♪", m, m + 2); }
    else if (shape === "bubble") { x.lineWidth = 3; x.beginPath(); x.arc(m, m, 26, 0, Math.PI * 2); x.globalAlpha = .9; x.stroke(); x.globalAlpha = .35; x.fill(); x.globalAlpha = 1; x.fillStyle = "#fff"; x.beginPath(); x.arc(m - 9, m - 9, 5, 0, Math.PI * 2); x.fill(); }
    else if (shape === "flame") { const g = x.createRadialGradient(m, m + 8, 2, m, m, 30); g.addColorStop(0, "#fff7c0"); g.addColorStop(.35, color); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.beginPath(); x.moveTo(m, 2); x.bezierCurveTo(58, 30, 54, 62, m, 62); x.bezierCurveTo(10, 62, 6, 30, m, 2); x.fill(); }
    else { x.beginPath(); x.arc(m, m, 26, 0, Math.PI * 2); x.fill(); }
    if (SPRITES.size > 200) SPRITES.clear(); SPRITES.set(key, c); return c;
  }
  const FX_CAP = 160;
  function fxSpawn(fx, d, px, py, k, n, front) {
    const life = pair(d.life, 1), speed = pair(d.speed, 60), size = pair(d.size, 14), cols = (d.colors && d.colors.length ? d.colors : ["#ffffff"]);
    const ang = (d.angle ?? -90) * Math.PI / 180, spr = (d.spread ?? 360) * Math.PI / 180, rad = (d.radius || 0) * k;
    for (let i = 0; i < n && fx.ps.length < FX_CAP; i++) {
      const a = ang + (Math.random() - .5) * spr, s = rnd(speed[0], speed[1]) * k, ra = Math.random() * Math.PI * 2, rr = rad * Math.sqrt(Math.random());
      fx.ps.push({ d, x: px + Math.cos(ra) * rr, y: py + Math.sin(ra) * rr * .7, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: Math.max(.05, rnd(life[0], life[1])),
        s0: size[0] * k, s1: size[1] * k, col: cols[Math.floor(Math.random() * cols.length)], rot: Math.random() * Math.PI * 2, vr: (d.spin || 0) * (Math.random() < .5 ? -1 : 1) * Math.PI * 2,
        back: !front && !!d.behind });
    }
  }
  function fxAnchor(W, def, e) {
    const L = (e.layer && W[e.layer]) || W[(def.layers.find(l => !l.parent) || def.layers[0] || {}).id]; if (!L) return null;
    const x = e.x || 0, y = e.y || 0;
    return [L[0] * x + L[2] * y + L[4], L[1] * x + L[3] * y + L[5], Math.hypot(L[0], L[1]) || 1];
  }
  function fxStep(p, dt) {
    const fx = p.fxs || (p.fxs = { ps: [], acc: [] }), list = p.def.effects || [];
    if (list.length && p.pose) {
      const W = world(p.def, p.pose, p.spring);
      list.forEach((e, i) => {
        const d = fxOf(e.fx); if (!d || !(d.rate > 0)) return;
        const at = fxAnchor(W, p.def, e); if (!at) return;
        fx.acc[i] = (fx.acc[i] || 0) + d.rate * dt;
        const n = Math.floor(fx.acc[i]); if (n > 0) { fx.acc[i] -= n; fxSpawn(fx, d, at[0], at[1], (e.scale || 1) * at[2], Math.min(n, 20)); }
      });
    }
    for (const q of fx.ps) {
      q.age += dt; const dr = Math.max(0, 1 - (q.d.drag || 0) * dt);
      q.vx *= dr; q.vy = q.vy * dr + (q.d.gravity || 0) * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vr * dt;
    }
    if (fx.ps.length) fx.ps = fx.ps.filter(q => q.age < q.life);
  }
  function fxDraw(p, ctx, x, y, scale, flip, behind) {
    const fx = p.fxs; if (!fx || !fx.ps.length) return;
    ctx.save(); ctx.translate(x, y); ctx.scale(flip ? -scale : scale, scale);
    for (const q of fx.ps) {
      if (q.back !== behind) continue;
      const t = q.age / q.life, al = pair(q.d.alpha, 1), a = al[0] + (al[1] - al[0]) * t, s = q.s0 + (q.s1 - q.s0) * t;
      if (a <= 0 || s <= 0) continue;
      const img = sprite(q.d.shape || "dot", q.col); if (!img) continue;
      ctx.globalAlpha = Math.min(1, a); ctx.globalCompositeOperation = q.d.blend === "add" ? "lighter" : "source-over";
      const rot = q.d.shape === "spark" ? Math.atan2(q.vy, q.vx) : (q.d.spin ? q.rot : 0);
      if (rot) { ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(rot); ctx.drawImage(img, -s / 2, -s / 2, s, s); ctx.restore(); }
      else ctx.drawImage(img, q.x - s / 2, q.y - s / 2, s, s);
    }
    ctx.restore();
  }


  // item motion that loops on its own: pulse (grow/shrink + glow), spin, bob (float), orbit (circles around, passing behind)
  function applyFx(def, pose, age) {
    for (const L of def.layers) {
      const fx = L.fx; if (!fx) continue;
      const p = pose[L.id]; if (!p) continue;
      const ph = fx.phase || 0;
      if (fx.pulse) { const w = Math.sin(age * 3 + ph), k = 1 + fx.pulse * w; p.sx *= k; p.sy *= k; p.alpha *= 1 - fx.pulse * 2 * (.5 + .5 * w); }
      if (fx.spin) p.rot += age * fx.spin * Math.PI * 2;
      if (fx.bob) p.y += Math.sin(age * 2.2 + ph) * fx.bob;
      if (fx.orbit) { const a = age * (fx.orbitSpeed || 1.2) + ph; p.x += Math.cos(a) * fx.orbit; p.y += Math.sin(a) * fx.orbit * .35; p.z = Math.sin(a) > 0 ? 50 : -50; }
    }
  }

  /* dress-up: base Spooner + items -> a playable character
     base: a character with anchors [{id, layer, x, y}] (x, y in that layer's space, before its picture scale)
     items: [{id, attach, offset:{x,y,rot,scale,z}, pivot:{x,y}, motion:{spring, pulse, spin, bob, orbit}, w, h}]
     equipped: [{item, color:{hue, sat}}]; images: {partId: img}. Recoloured copies are added to images as "partId~hue". */
  const ATTACH_Z = { aura: -30, back: -20, top: -4, "top-left": -4, "top-right": -4, orbit: 0, body: 2, bottom: 4, "bottom-left": 4, "bottom-right": 4, face: 6, mouth: 7, eyes: 8, "hand-left": 10, "hand-right": 10 };
  const ATTACH_SIZE = { aura: 1.7, back: 1.3, body: 1, face: .7, top: .75, "top-left": .45, "top-right": .45, bottom: .6, "bottom-left": .4, "bottom-right": .4, eyes: .55, mouth: .3, "hand-left": .32, "hand-right": .32, orbit: .32 };
  // a colour choice: {hue, sat} shifts the drawing's colours; {color:"#ff3355"} paints it that colour but keeps its shading and shine
  function recolor(images, id, spec) {
    if (!spec || !images || !images[id]) return id;
    const hue = +spec.hue || 0, sat = spec.sat != null ? +spec.sat : 1, color = /^#[0-9a-f]{6}$/i.test(spec.color || "") ? spec.color.toLowerCase() : "";
    if (!color && !hue && sat === 1) return id;
    const key = id + "~" + (color || Math.round(hue)) + "~" + sat;
    if (!images[key]) images[key] = tint(images[id], hue, sat, color);
    return key;
  }
  function dress(base, items, equipped, images, paint) {
    const def = JSON.parse(JSON.stringify(base));
    def.id = (base.id || "spooner") + "+outfit";
    const byId = {}; for (const it of items || []) byId[it.id] = it;
    const anchors = {}; for (const a of base.anchors || []) anchors[a.id] = a;
    const root = base.layers.find(l => !l.parent) || base.layers[0];
    const rim = root && images && images[root.part];
    const baseSize = rim ? Math.max(rim.naturalWidth || rim.width, rim.naturalHeight || rim.height) * (root.ps || 1) : 170;
    for (const L of def.layers) if (paint && paint[L.id]) L.part = recolor(images, L.part, paint[L.id]);   // body colour zones
    let n = 0;
    for (const eq of equipped || []) {
      const it = byId[eq.item]; if (!it || (!it.w && !it.fx)) continue;
      const at = it.attach && it.attach !== "none" ? it.attach : "body";
      const a = anchors[at] || (root ? { layer: root.id, x: 0, y: 0 } : null); if (!a) continue;
      if (it.fx) {                                                     // an effect item (sparkles, fire aura...): particles where it attaches
        const fxd = fxOf(it.fx), col = eq.color && eq.color.color;
        def.effects = (def.effects || []).concat([{ fx: col && fxd ? Object.assign({}, fxd, { colors: [col, "#ffffff"] }) : it.fx, layer: a.layer, x: a.x, y: a.y }]);
        if (it.fxOnly || !it.w) continue;
      }
      const io = it.offset || {}, eo = eq.offset || {}, m = it.motion || {};
      const o = { x: (io.x || 0) + (eo.x || 0), y: (io.y || 0) + (eo.y || 0), rot: (io.rot || 0) + (eo.rot || 0), z: (io.z || 0) + (eo.z || 0), scale: (io.scale || 1) * (eo.scale || 1) };
      const pv = it.pivot || defaultPivot(at, it.w, it.h);
      const part = recolor(images, it.id, eq.color);
      const L = { id: "eq" + (n++) + "-" + it.id, name: it.name || it.id, part, parent: a.layer, x: a.x + (o.x || 0), y: a.y + (o.y || 0), rot: o.rot || 0,
        sx: 1, sy: 1, alpha: 1, px: pv.x, py: pv.y, ps: +(o.scale * baseSize * (ATTACH_SIZE[at] ?? .6) / Math.max(it.w, it.h)).toFixed(4), z: (ATTACH_Z[at] ?? 5) + (o.z || 0) + n * .01, item: it.id };
      if (m.spring) L.spring = { on: true, stiff: .5, damp: .35, amt: m.spring, dir: /^bottom/.test(at) ? 1 : -1 };
      if (m.pulse || m.spin || m.bob || m.orbit) L.fx = { pulse: m.pulse || 0, spin: m.spin || 0, bob: m.bob || 0, orbit: m.orbit || 0, orbitSpeed: m.orbitSpeed || 1.2, phase: n * 1.7 };
      def.layers.push(L);
    }
    return def;
  }
  function defaultPivot(at, w, h) {
    if (/^top/.test(at)) return { x: w / 2, y: h * .9 };        // grows up from the orb
    if (/^bottom/.test(at)) return { x: w / 2, y: h * .1 };     // hangs down
    return { x: w / 2, y: h / 2 };
  }
  function tint(img, hue, sat, color) {                            // one drawing -> every colour
    const c = document.createElement("canvas");
    const draw = () => {
      const w = c.width = img.naturalWidth || img.width, h = c.height = img.naturalHeight || img.height;
      const x = c.getContext("2d");
      if (color) {                                                   // paint: keep light and dark, take the new colour
        x.filter = `grayscale(1) contrast(1.1) brightness(${.85 + .3 * (sat ?? 1)})`; x.drawImage(img, 0, 0); x.filter = "none";
        x.globalCompositeOperation = "color"; x.fillStyle = color; x.fillRect(0, 0, w, h);
        x.globalCompositeOperation = "destination-in"; x.drawImage(img, 0, 0); x.globalCompositeOperation = "source-over";
      } else { x.filter = `hue-rotate(${hue}deg) saturate(${sat ?? 1})`; x.drawImage(img, 0, 0); }
    };
    if (img.complete === false || !(img.naturalWidth || img.width)) img.addEventListener("load", draw, { once: true }); else draw();
    return c;
  }

  // secondary motion: a springy layer lags behind how its pivot accelerates, then wobbles back
  function stepSprings(p, dt) {
    if (!Object.keys(p.spring).length || dt <= 0) return;
    const W = world(p.def, p.pose, p.spring), xy = p.lastXY || [0, 0, 1, false];
    for (const L of p.def.layers) {
      const s = p.spring[L.id]; if (!s) continue;
      const m = W[L.id], wx = (xy[3] ? -1 : 1) * m[4] * xy[2] + xy[0], wy = m[5] * xy[2] + xy[1];
      const pr = p.prev[L.id] || { x: wx, y: wy, vx: 0, vy: 0 };
      const vx = (wx - pr.x) / dt, vy = (wy - pr.y) / dt, ax = (vx - pr.vx) / dt, ay = (vy - pr.vy) / dt;
      p.prev[L.id] = { x: wx, y: wy, vx, vy };
      // steady push gives a lean of about amt * accel; stiff = how fast it follows, damp = how quickly the wobble settles
      const k = 30 + 270 * (L.spring.stiff ?? .5), d = 2 * Math.sqrt(k) * (.15 + .85 * (L.spring.damp ?? .35));
      const amt = (L.spring.amt ?? .5) * .0006, dir = L.spring.dir || 1;              // dir: +1 hangs down from its pivot, -1 sticks up
      const axL = Math.max(-5000, Math.min(5000, ax)) * (xy[3] ? -1 : 1) / (xy[2] || 1);
      const ayL = Math.max(-5000, Math.min(5000, ay)) / (xy[2] || 1);
      const push = dir * axL + .35 * ayL * Math.sign(s.a || dir);
      s.v += (-k * s.a - d * s.v + push * amt * k) * dt;
      s.a = Math.max(-1.2, Math.min(1.2, s.a + s.v * dt));
    }
  }

  function loadImages(data, ids, base) {
    const images = {};
    return Promise.all(ids.map(id => new Promise(res => {
      const info = data.parts[id]; if (!info) return res();
      const im = new Image(); im.onload = im.onerror = () => res(); im.src = (base || "") + info.src; images[id] = im;
    }))).then(() => images);
  }

  function partsUsed(def) {
    const ids = new Set(def.layers.map(L => L.part).filter(Boolean));
    for (const sk of def.skins || []) for (const v of Object.values(sk.swap || {})) ids.add(v);
    for (const clip of Object.values(def.clips || {})) for (const tr of Object.values(clip.tracks || {})) for (const k of tr.img || []) ids.add(k.v);
    return [...ids].filter(Boolean);
  }

  root.SpoonerPlayer = {
    version: 5, impactOf, lifeOf, EASE, PROPS, STEP_PROPS, poseAt, world, drawPose, partsUsed, Puppet, dress, tint, recolor, applyFx, ATTACH_Z, ATTACH_SIZE,
    /** load a character from an export (window.SPOONERS_DATA) */
    registerEffects, effects: FXLIB,
    async load(data, id, base) {
      registerEffects(data.effects);
      const def = data.characters[id]; if (!def) throw new Error("No character " + id);
      const images = await loadImages(data, partsUsed(def), base);
      return new Puppet(def, images, data.parts);
    },
    /** a dressed Spooner: an outfit id from the Workshop, or {base, equipped:[{item, color}], paint:{zoneLayerId: color}} from a player's save */
    async loadOutfit(data, outfit, base) {
      const o = typeof outfit === "string" ? (data.outfits || []).find(x => x.id === outfit) : outfit;
      if (!o) throw new Error("No outfit " + outfit);
      registerEffects(data.effects);
      const b = data.characters[o.base]; if (!b) throw new Error("No base Spooner " + o.base);
      const ids = new Set(partsUsed(b)); for (const e of o.equipped || []) ids.add(e.item);
      const images = await loadImages(data, [...ids], base);
      return new Puppet(dress(b, data.items || [], o.equipped, images, o.paint), images, data.parts);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
