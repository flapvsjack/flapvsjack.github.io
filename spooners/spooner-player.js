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
 * Dress-up: SpoonerPlayer.dress(base, items, equipped, images) puts shop items (hair, auras, companions...) onto a
 * base Spooner at its anchor points; they follow its animations and move on their own (fx: pulse, spin, bob, orbit).
 */
(function (root) {
  "use strict";
  const PROPS = ["x", "y", "rot", "sx", "sy", "alpha", "glow"];   // glow: 0 = off, 1 = full (keyable, e.g. a mouth that lights up in chat)
  const STEP_PROPS = ["img", "z"];
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
      for (const k of PROPS) p[k] = sample(tr[k], t, L[k] ?? (k === "sx" || k === "sy" || k === "alpha" ? 1 : 0), false);
      p.img = sample(tr.img, t, L.part, true);
      p.z = sample(tr.z, t, L.z || 0, true);
      pose[L.id] = p;
    }
    return pose;
  }

  /** World matrices [a, b, c, d, e, f] for each layer (character space: origin at the feet, y down). */
  function world(def, pose, spring) {
    const out = {}, byId = {};
    for (const L of def.layers) byId[L.id] = L;
    const calc = id => {
      if (out[id]) return out[id];
      const L = byId[id], p = pose[id];
      const par = L.parent && byId[L.parent] ? calc(L.parent) : [1, 0, 0, 1, 0, 0];
      const r = p.rot + ((spring && spring[id]) ? spring[id].a : 0), c = Math.cos(r), s = Math.sin(r);
      const m = [c * p.sx, s * p.sx, -s * p.sy, c * p.sy, p.x, p.y];      // T * R * S
      out[id] = [par[0] * m[0] + par[2] * m[1], par[1] * m[0] + par[3] * m[1], par[0] * m[2] + par[2] * m[3], par[1] * m[2] + par[3] * m[3],
                 par[0] * m[4] + par[2] * m[5] + par[4], par[1] * m[4] + par[3] * m[5] + par[5]];
      return out[id];
    };
    for (const L of def.layers) calc(L.id);
    return out;
  }

  /** Draw a pose. images: {partId: HTMLImageElement}. opts: {alpha, only, tint} */
  function drawPose(ctx, def, pose, images, parts, x, y, scale, flip, spring, opts) {
    opts = opts || {};
    const W = world(def, pose, spring);
    const order = def.layers.slice().sort((a, b) => (pose[a.id].z - pose[b.id].z) || (def.layers.indexOf(a) - def.layers.indexOf(b)));
    ctx.save();
    ctx.translate(x, y); ctx.scale(flip ? -scale : scale, scale);
    const base = ctx.getTransform();
    for (const L of order) {
      const p = pose[L.id], img = images[p.img];
      const iw = img && (img.naturalWidth || img.width), ih = img && (img.naturalHeight || img.height);
      if (!img || img.complete === false || !iw || p.alpha <= 0 || L.hidden) continue;
      if (opts.only && !opts.only.has(L.id)) continue;
      const m = W[L.id], ps = L.ps || 1;
      ctx.setTransform(base); ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.globalAlpha = p.alpha * (opts.alpha ?? 1);
      const lk = L.look || {}, g = Math.max(0, Math.min(1.5, +p.glow || 0)), src = tinted(img, lk, iw, ih);
      const bright = (lk.bright ?? 1) * (1 + .35 * g);
      ctx.filter = (lk.hue || (lk.sat ?? 1) !== 1 || bright !== 1) ? `hue-rotate(${lk.hue || 0}deg) saturate(${lk.sat ?? 1}) brightness(${bright.toFixed(3)})` : "none";
      if (g > 0) {                                                       // glow: a coloured halo, twice when strong
        const sc = Math.hypot(m[0], m[1]) * Math.abs(scale);
        ctx.shadowColor = lk.glowColor || "#37e8ff"; ctx.shadowBlur = Math.max(1, (lk.glowSize ?? 18) * g * sc);
        ctx.drawImage(src, -(L.px || 0) * ps, -(L.py || 0) * ps, iw * ps, ih * ps);
        if (g > .5) ctx.drawImage(src, -(L.px || 0) * ps, -(L.py || 0) * ps, iw * ps, ih * ps);
        ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
      } else ctx.drawImage(src, -(L.px || 0) * ps, -(L.py || 0) * ps, iw * ps, ih * ps);
      ctx.filter = "none";
    }
    ctx.restore();
    return W;
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

  class Puppet {
    constructor(def, images, parts) {
      this.def = def; this.images = images; this.parts = parts || {};
      this.clip = null; this.t = 0; this.age = 0; this.speed = 1; this.queue = null; this.listeners = [];
      this.spring = {}; this.prev = {};
      for (const L of def.layers) if (L.spring && L.spring.on) this.spring[L.id] = { a: 0, v: 0 };
      this.play((def.clips || {}).idle ? "idle" : Object.keys(def.clips || {})[0]);
    }
    has(name) { return !!(this.def.clips || {})[name]; }
    /** play a clip; a non-looping clip goes back to "then" (default idle) when it ends */
    play(name, opts) {
      opts = opts || {};
      if (!this.has(name)) return false;
      if (this.clip === name && !opts.restart) return true;
      this.clip = name; this.t = 0; this.then = opts.then || "idle"; this.fired = new Set();
      return true;
    }
    on(fn) { this.listeners.push(fn); }
    update(dt) {
      const clip = (this.def.clips || {})[this.clip];
      if (clip) {
        this.t += dt * this.speed;
        for (const ev of clip.events || []) if (this.t >= ev.t && !this.fired.has(ev)) { this.fired.add(ev); this.listeners.forEach(f => f(ev.name, this.clip)); }
        if (this.t >= clip.len) {
          if (clip.loop !== false) { this.t %= Math.max(.01, clip.len); this.fired = new Set(); }
          else { this.listeners.forEach(f => f("end", this.clip)); if (!this.play(this.then)) this.t = clip.len; }
        }
      }
      this.age += dt;
      this.pose = poseAt(this.def, this.clip, this.t);
      applyFx(this.def, this.pose, this.age);
      stepSprings(this, dt);
    }
    draw(ctx, x, y, scale, flip, opts) {
      if (!this.pose) this.pose = poseAt(this.def, this.clip, this.t);
      this.lastXY = [x, y, scale || 1, flip];
      return drawPose(ctx, this.def, this.pose, this.images, this.parts, x, y, scale || 1, flip, this.spring, opts);
    }
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
      const it = byId[eq.item]; if (!it || !it.w) continue;
      const at = it.attach && it.attach !== "none" ? it.attach : "body";
      const a = anchors[at] || (root ? { layer: root.id, x: 0, y: 0 } : null); if (!a) continue;
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
    const ids = new Set(def.layers.map(L => L.part));
    for (const clip of Object.values(def.clips || {})) for (const tr of Object.values(clip.tracks || {})) for (const k of tr.img || []) ids.add(k.v);
    return [...ids].filter(Boolean);
  }

  root.SpoonerPlayer = {
    version: 3, EASE, PROPS, STEP_PROPS, poseAt, world, drawPose, partsUsed, Puppet, dress, tint, recolor, applyFx, ATTACH_Z, ATTACH_SIZE,
    /** load a character from an export (window.SPOONERS_DATA) */
    async load(data, id, base) {
      const def = data.characters[id]; if (!def) throw new Error("No character " + id);
      const images = await loadImages(data, partsUsed(def), base);
      return new Puppet(def, images, data.parts);
    },
    /** a dressed Spooner: an outfit id from the Workshop, or {base, equipped:[{item, color}], paint:{zoneLayerId: color}} from a player's save */
    async loadOutfit(data, outfit, base) {
      const o = typeof outfit === "string" ? (data.outfits || []).find(x => x.id === outfit) : outfit;
      if (!o) throw new Error("No outfit " + outfit);
      const b = data.characters[o.base]; if (!b) throw new Error("No base Spooner " + o.base);
      const ids = new Set(partsUsed(b)); for (const e of o.equipped || []) ids.add(e.item);
      const images = await loadImages(data, [...ids], base);
      return new Puppet(dress(b, data.items || [], o.equipped, images, o.paint), images, data.parts);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
