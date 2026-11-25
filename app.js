/* flapvsjack site: renders everything from data/site.json (edited in Cutroom > Webpage).
   data/auto.json is kept up to date by Cutroom by itself: upcoming Discord events (they go on the schedule and in News)
   and the follower count for the goal.
   Cutroom's preview can also send fresh data with postMessage({type:"site-data", data}) to show a draft live. */
(function () {
  "use strict";
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const SHELVES = ["Now playing", "Up next", "Backlog", "Finished"];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "");
  let S = null;            // the site data
  let A = null;            // data/auto.json: Discord events + follower count (may be missing)
  let tick = 0;

  // ---------------------------------------------------------------- time (always the streamer's time zone)
  function tz() { return (S && S.timezone) || "America/Chicago"; }
  function wall(date) {    // the streamer's wall clock for a moment: {y,m,d,day(0=Mon),min,sec}
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, day: DAYS.indexOf(p.weekday), min: +p.hour * 60 + +p.minute, sec: +p.second };
  }
  function tzOffsetMs(date) {   // how far the streamer's wall clock is from UTC right now
    const w = wall(date);
    return Date.UTC(w.y, w.m - 1, w.d, Math.floor(w.min / 60), w.min % 60, w.sec) - Math.floor(date.getTime() / 1000) * 1000;
  }
  const toMin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  function fmt(t) { if (!t) return ""; const [h, m] = t.split(":").map(Number); return (h % 12 || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h >= 12 ? " PM" : " AM"); }
  const pad2 = (n) => String(n).padStart(2, "0");
  const todayStr = (w) => `${w.y}-${pad2(w.m)}-${pad2(w.d)}`;
  function daysUntil(date, w) { const [y, m, d] = String(date).split("-").map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(w.y, w.m - 1, w.d)) / 86400000); }
  // Discord events (from Cutroom) for the coming 7 days, as one-off schedule rows
  function eventRows() {
    if (S.discordSync === false) return [];
    const w = wall(new Date());
    return ((A && A.events) || []).filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date || "")).map((e) => {
      const ahead = daysUntil(e.date, w);
      return ahead >= 0 && ahead <= 6 ? { id: String(e.id), day: +e.day, start: e.start || "", end: e.end || "", game: e.name || "Stream", platform: e.platform || "Both",
        format: "", status: "confirmed", notes: e.notes || "", link: safeUrl(e.link), date: e.date, discord: true } : null;
    }).filter(Boolean);
  }
  // the schedule shown: your usual week, where a day with a Discord event shows the event instead
  function schedule() {
    const ev = eventRows(); if (!ev.length) return S.schedule || [];
    const days = new Set(ev.map((e) => e.day));
    return (S.schedule || []).filter((s) => !days.has(+s.day)).concat(ev);
  }
  function slotsLive() { return schedule().filter((s) => s.status !== "cancelled"); }
  function liveNow() {     // ▶ Start stream in Cutroom turns this on (and ■ End stream off); ignored after 14 hours
    const l = S && S.live; if (!l || !l.on) return null;
    const t = l.since ? Date.parse(l.since + (/[zZ]|[+-]\d\d:?\d\d$/.test(l.since) ? "" : "Z")) - tzOffsetMs(new Date()) : 0;
    return !l.since || isNaN(t) || Date.now() - t < 14 * 3600 * 1000 ? l : null;
  }
  function nextStream() {
    const now = new Date(), w = wall(now), list = slotsLive();
    const lv = liveNow();
    if (lv) { const today = list.find((s) => s.day === w.day) || {}; return { s: Object.assign({ day: w.day, start: "", end: "", platform: today.platform || "Both" }, today, lv.game ? { game: lv.game } : {}), live: true, title: lv.title || "" }; }
    for (const s of list) {
      if (s.date ? s.date !== todayStr(w) : s.day !== w.day) continue;
      const a = toMin(s.start), b0 = toMin(s.end || s.start), b = b0 <= a ? b0 + 1440 : b0;
      if (w.min >= a && w.min < b) return { s, live: true };
    }
    let best = null, bestMin = 1e9;
    for (const s of list) {
      let d = s.date ? daysUntil(s.date, w) * 1440 + toMin(s.start) - w.min : (s.day - w.day) * 1440 + toMin(s.start) - w.min;
      if (d <= 0) { if (s.date) continue; d += 7 * 1440; }    // a Discord event happens once; your usual week repeats
      if (d < bestMin) { bestMin = d; best = s; }
    }
    if (!best) return null;
    const at = new Date(Math.floor(now.getTime() / 60000) * 60000 + bestMin * 60000);
    return { s: best, live: false, at };
  }
  function weekDates() {  // Monday..Sunday of the streamer's current week, as "Nov 17"
    const now = new Date(), w = wall(now);
    const base = Date.UTC(w.y, w.m - 1, w.d) - w.day * 86400000;
    return DAYS.map((_, i) => new Date(base + i * 86400000));
  }

  // ---------------------------------------------------------------- theme
  function shade(hex, f) {
    const n = parseInt(String(hex).replace("#", ""), 16); if (isNaN(n)) return hex;
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
    return "#" + [ch(n >> 16 & 255), ch(n >> 8 & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  function applyTheme() {
    const a = (S.theme && /^#[0-9a-f]{6}$/i.test(S.theme.a) && S.theme.a) || "#1787b4";
    const b = (S.theme && /^#[0-9a-f]{6}$/i.test(S.theme.b) && S.theme.b) || "#ffffff";
    const r = document.documentElement.style;
    r.setProperty("--a", a); r.setProperty("--a-deep", shade(a, 0.78)); r.setProperty("--b", b);
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = a;
  }

  // ---------------------------------------------------------------- links
  const LINKS = [["discord", "Discord", "#5865f2"], ["twitch", "Twitch", "#9146ff"], ["youtube", "YouTube", "#ff0000"], ["patreon", "Patreon", "#ff424d"],
    ["kofi", "Ko-fi", "#29abe0"], ["merch", "Merch", "#1787b4"], ["tiktok", "TikTok", "#111"], ["instagram", "Instagram", "#d62976"], ["x", "X", "#111"]];
  function discordUrl() { return safeUrl(S.links && S.links.discord) || (S._widget && safeUrl(S._widget.instant_invite)) || ""; }
  function linkChips() {
    return LINKS.map(([k, label, color]) => {
      const url = k === "discord" ? discordUrl() : safeUrl(S.links && S.links[k]);
      if (!url) return "";
      return `<a class="lchip${k === "discord" ? " discord" : ""}" href="${esc(url)}" target="_blank" rel="noopener"><i style="background:${color}"></i>${label}</a>`;
    }).join("");
  }
  function setDiscordButtons() {
    const url = discordUrl();
    ["topDiscord", "dcJoin"].forEach((id) => { const a = $(id); if (!a) return; if (url) { a.href = url; a.hidden = false; } else a.hidden = true; });
  }

  // ---------------------------------------------------------------- the three panels
  const stage = $("top");
  const panels = { hub: $("hub"), discord: $("discord"), schedule: $("schedule") };
  let openKey = "", d1 = 0, d2 = 0, anim = 0;
  const wide = () => matchMedia("(min-width:860px)").matches;
  function geometry() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const s = Math.round(Math.min(110, H * 0.12));      // half the slant of each line
    const c = Math.round(Math.max(76, Math.min(120, W * 0.085)));   // width of a closed strip
    return { W, H, s, c };
  }
  let hoverKey = "";
  function targets(key, g, hover) {
    const { W, s, c } = g;
    if (key === "hub") { const b = W - c - s; return [b - c, b]; }
    if (key === "discord") return [c + s, W - c - s];
    if (key === "schedule") { const a = c + s; return [a, a + c]; }
    const n = W * 0.07;                 // nothing open: the panel under the mouse leans out a little
    if (hover === "hub") return [W / 3 + n, (2 * W) / 3 + n * 0.45];
    if (hover === "discord") return [W / 3 - n * 0.6, (2 * W) / 3 + n * 0.6];
    if (hover === "schedule") return [W / 3 - n * 0.45, (2 * W) / 3 - n];
    return [W / 3, (2 * W) / 3];
  }
  function paint() {
    const g = geometry(), { W, s } = g, gap = 3;
    // --x/--w: the part of a panel clear of both slanted lines (for its content);
    // --hx/--hw: the panel at mid-height (a closed strip's label is centred there)
    const set = (el, clip, x, w, hx, hw) => { const st = el.style; st.setProperty("--clip", clip); st.setProperty("--x", x + "px"); st.setProperty("--w", Math.max(0, w) + "px");
      st.setProperty("--hx", hx + "px"); st.setProperty("--hw", Math.max(0, hw) + "px"); };
    set(panels.hub, `polygon(0 0,${d1 + s - gap}px 0,${d1 - s - gap}px 100%,0 100%)`, 0, d1 - s - gap, 0, d1 - gap);
    set(panels.discord, `polygon(${d1 + s + gap}px 0,${d2 + s - gap}px 0,${d2 - s - gap}px 100%,${d1 - s + gap}px 100%)`, d1 + s + gap, d2 - d1 - 2 * s - 2 * gap, d1 + gap, d2 - d1 - 2 * gap);
    set(panels.schedule, `polygon(${d2 + s + gap}px 0,${W}px 0,${W}px 100%,${d2 - s + gap}px 100%)`, d2 + s + gap, W - d2 - s - gap, d2 + gap, W - d2 - gap);
  }
  // open/close: quick start, soft settle with a slight overshoot. Hover: shorter and calmer.
  const easeOpen = (x) => { const c1 = 0.7, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  const easeHover = (x) => 1 - Math.pow(1 - x, 3);
  function layout(animate, kind) {
    if (!wide()) { Object.values(panels).forEach((p) => { p.style.removeProperty("--clip"); }); return; }
    const g = geometry(), [t1, t2] = targets(openKey, g, hoverKey);
    cancelAnimationFrame(anim);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce || !d2) { d1 = t1; d2 = t2; paint(); stage.classList.remove("moving"); return; }
    const hover = kind === "hover", f1 = d1, f2 = d2, t0 = performance.now(), dur = hover ? 420 : 820, ease = hover ? easeHover : easeOpen;
    if (!hover) stage.classList.add("moving");
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = ease(k);
      d1 = f1 + (t1 - f1) * e; d2 = f2 + (t2 - f2) * e; paint();
      if (k < 1) anim = requestAnimationFrame(step); else stage.classList.remove("moving");
    };
    anim = requestAnimationFrame(step);
  }
  function stagger(p) {           // the opened panel's blocks slide in from the right, one after another
    const kids = [...p.querySelectorAll(".p3-scroll > :not(.p3-close)")];
    kids.forEach((el, i) => el.style.setProperty("--i", i));
    p.classList.remove("enter"); void p.offsetWidth; p.classList.add("enter");
  }
  function openPanel(key, scroll) {
    openKey = key && openKey !== key ? key : (key && scroll ? key : "");
    hoverKey = "";
    stage.classList.toggle("has-open", !!openKey);
    for (const [k, p] of Object.entries(panels)) {
      const on = k === openKey;
      p.classList.toggle("open", on);
      if (on) stagger(p); else p.classList.remove("enter");
      p.querySelector(".p3-head").setAttribute("aria-expanded", on ? "true" : "false");
      p.querySelector(".p3-body").setAttribute("aria-hidden", on ? "false" : "true");
    }
    document.querySelectorAll(".mainnav a[data-open]").forEach((a) => a.classList.toggle("on", a.dataset.open === openKey));
    layout(true);
    if (openKey === "schedule") replayCascade();
    if (openKey && !wide()) panels[openKey].scrollIntoView({ behavior: "smooth", block: "start" });
    else if (scroll) stage.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const canHover = () => matchMedia("(hover: hover) and (pointer: fine)").matches;
  Object.entries(panels).forEach(([k, p]) => {
    p.addEventListener("pointerenter", () => { if (!openKey && wide() && canHover() && hoverKey !== k) { hoverKey = k; layout(true, "hover"); } });
  });
  stage.addEventListener("pointerleave", () => { if (!openKey && hoverKey) { hoverKey = ""; layout(true, "hover"); } });
  Object.entries(panels).forEach(([k, p]) => {
    p.querySelector(".p3-head").addEventListener("click", () => openPanel(k));
    const close = document.createElement("button");
    close.type = "button"; close.className = "p3-close"; close.textContent = "Close ✕";
    close.addEventListener("click", () => openPanel(""));
    p.querySelector(".p3-scroll").prepend(close);
  });
  document.querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openPanel(a.dataset.open, true); }));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && openKey) openPanel(""); });
  addEventListener("resize", () => layout(false));

  // ---------------------------------------------------------------- hub
  const HATS = ["none", "crown", "cap", "beanie", "halo", "horns", "headphones"];
  const COLORS = ["#1787b4", "#ff4fa3", "#3ee6ff", "#ffcc33", "#7ad35a", "#9a6bff", "#ff6b3d", "#f2f2f2"];
  const me = { color: COLORS[0], hat: "crown", name: "" };
  function hatSvg(h) {
    switch (h) {
      case "crown": return '<path d="M52 40 l8 -18 l10 12 l10 -16 l10 16 l10 -12 l8 18 z" fill="#ffcc33" stroke="#0b2533" stroke-width="3" stroke-linejoin="round"/>';
      case "cap": return '<path d="M48 44 q32 -34 64 0 z" fill="#ff4fa3" stroke="#0b2533" stroke-width="3"/><path d="M104 44 h24" stroke="#0b2533" stroke-width="5" stroke-linecap="round"/>';
      case "beanie": return '<path d="M48 46 q32 -40 64 0 z" fill="#3ee6ff" stroke="#0b2533" stroke-width="3"/><circle cx="80" cy="16" r="6" fill="#fff" stroke="#0b2533" stroke-width="3"/>';
      case "halo": return '<ellipse cx="80" cy="18" rx="24" ry="7" fill="none" stroke="#ffcc33" stroke-width="5"/>';
      case "horns": return '<path d="M54 44 q-10 -22 4 -30 q0 16 10 24z M106 44 q10 -22 -4 -30 q0 16 -10 24z" fill="#e5302a" stroke="#0b2533" stroke-width="3"/>';
      case "headphones": return '<path d="M44 74 q0 -54 36 -54 q36 0 36 54" fill="none" stroke="#0b2533" stroke-width="6"/><rect x="36" y="68" width="14" height="24" rx="5" fill="#ff4fa3" stroke="#0b2533" stroke-width="3"/><rect x="110" y="68" width="14" height="24" rx="5" fill="#ff4fa3" stroke="#0b2533" stroke-width="3"/>';
      default: return "";
    }
  }
  function drawSpooner() {
    const name = me.name.trim() || "Spooner";
    $("spStage").innerHTML = `<svg viewBox="0 0 160 180" role="img" aria-label="${esc(name)}, a Spooner with a ${esc(me.hat)} hat">
      <ellipse cx="80" cy="168" rx="40" ry="7" fill="rgba(0,0,0,.35)"/>
      <path d="M40 160 q-6 -70 40 -112 q46 42 40 112 z" fill="${me.color}" stroke="#0b2533" stroke-width="4" stroke-linejoin="round"/>
      <ellipse cx="66" cy="98" rx="8" ry="10" fill="#fff" stroke="#0b2533" stroke-width="3"/><ellipse cx="94" cy="98" rx="8" ry="10" fill="#fff" stroke="#0b2533" stroke-width="3"/>
      <circle cx="68" cy="100" r="4" fill="#0b2533"/><circle cx="96" cy="100" r="4" fill="#0b2533"/>
      <path d="M68 122 q12 10 24 0" fill="none" stroke="#0b2533" stroke-width="3" stroke-linecap="round"/>
      <g transform="translate(0,${me.hat === "headphones" ? 12 : 4})">${hatSvg(me.hat)}</g>
    </svg><div style="margin-top:6px;font:700 13px/1 var(--mono);background:#0b2533;color:#fff;padding:5px 9px;border-radius:5px">${esc(name)}</div>`;
    $("spStage").style.display = "grid";
  }
  function renderHub() {
    const sp = S.spooners || {};
    $("spStatus").textContent = sp.status || "In development";
    $("spBlurb").textContent = sp.blurb || "";
    $("spFeatures").innerHTML = (sp.features || []).map((f, i) => `<li><span class="fi">${String(i + 1).padStart(2, "0")}</span><div><b>${esc(f.name)}</b><span>${esc(f.text)}</span></div></li>`).join("");
    $("hubTeaser").textContent = sp.teaser || "Make your Spooner, shop and raid online.";
    if (!$("spColors").children.length) {
      $("spColors").innerHTML = COLORS.map((c) => `<button type="button" style="background:${c}" aria-label="Colour ${c}" aria-pressed="${c === me.color}" data-c="${c}"></button>`).join("");
      $("spHats").innerHTML = HATS.map((h) => `<button type="button" aria-pressed="${h === me.hat}" data-h="${h}">${h}</button>`).join("");
      $("spColors").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; me.color = b.dataset.c; $("spColors").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); drawSpooner(); });
      $("spHats").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; me.hat = b.dataset.h; $("spHats").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); drawSpooner(); });
      $("spName").addEventListener("input", () => { me.name = $("spName").value; drawSpooner(); });
    }
    drawSpooner();
    const shop = (sp.shop && sp.shop.length ? sp.shop : [
      { icon: "🛡️", name: "Knight skin", price: "500 spoons" }, { icon: "🤖", name: "Mech skin", price: "750 spoons" },
      { icon: "👑", name: "Gold crown", price: "300 spoons" }, { icon: "🎧", name: "Neon headphones", price: "200 spoons" },
      { icon: "💃", name: "Victory dance", price: "150 spoons" }, { icon: "✨", name: "Name glow", price: "250 spoons" },
      { icon: "⚔️", name: "Raid banner", price: "400 spoons" }, { icon: "🥄", name: "Golden spoon", price: "1000 spoons" }]);
    $("shopGrid").innerHTML = shop.map((it) => `<div class="item"><div class="ico" aria-hidden="true">${esc(it.icon || "🥄")}</div><b>${esc(it.name)}</b><span>${esc(it.price || "")}</span></div>`).join("");
  }

  // ---------------------------------------------------------------- discord
  function renderDiscord() {
    const dc = S.discord || {};
    $("dcServer").textContent = S.community || "OnionS Spoon Alliance";
    const r = S.raids || {};
    $("raidWhen").textContent = r.when || "";
    $("raidWhen").hidden = !r.when;
    $("raidHow").textContent = r.how || "";
    $("raidModes").innerHTML = (r.modes || []).map((m) => `<div class="raid">${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy">` : ""}<div class="rb"><h4>${esc(m.name)}</h4><p>${esc(m.text)}</p></div></div>`).join("");
    $("dcTeaser").textContent = r.when ? `Raids & Horde Mode · ${r.when}` : "Raids, Horde Mode and the OnionS Spoon Alliance.";
    const w = S._widget;
    const box = $("dcLive");
    if (w && typeof w.presence_count === "number") {
      const faces = (w.members || []).slice(0, 14).map((m) => `<img src="${esc(safeUrl(m.avatar_url))}" alt="" title="${esc(m.username)}" loading="lazy">`).join("");
      box.innerHTML = `<div class="online"><span class="dot"></span>${w.presence_count} Spooners online now</div><div class="avatars">${faces}</div>` +
        (dc.voiceChannel ? `<p class="small" style="color:#e2f4fb">Raids happen in the <b>${esc(dc.voiceChannel)}</b> voice channel.</p>` : "");
      box.hidden = false;
    } else box.hidden = true;
    setDiscordButtons();
  }
  async function loadWidget() {
    const id = S.discord && String(S.discord.guildId || "").trim();
    if (!/^\d{5,25}$/.test(id || "")) return;
    try {
      const r = await fetch(`https://discord.com/api/guilds/${id}/widget.json`, { cache: "no-store" });
      if (!r.ok) return;           // 403 = Server Widget is turned off in Discord
      S._widget = await r.json();
      renderDiscord(); renderLinks();
    } catch (e) { /* offline or blocked: the page works without it */ }
  }

  // ---------------------------------------------------------------- schedule
  function platTags(p) {
    if (p === "Both") return '<span class="tag tw">Twitch</span><span class="tag yt">YouTube</span>';
    if (p === "Twitch") return '<span class="tag tw">Twitch</span>';
    if (p === "YouTube") return '<span class="tag yt">YouTube</span>';
    if (p === "Discord") return '<span class="tag dc">Discord</span>';
    return "";
  }
  function fmtTags(f) { return f === "Both" ? '<span class="tag">Landscape</span><span class="tag">Vertical</span>' : f ? `<span class="tag">${esc(f)}</span>` : ""; }
  function renderSchedule() {
    const lbl = S.tzLabel || "CT", w = wall(new Date()), dates = weekDates();
    $("weekNote").textContent = S.weekNote || ""; $("weekNote").hidden = !S.weekNote;
    $("week").innerHTML = DAYS.map((d, i) => {
      const ss = schedule().filter((s) => +s.day === i).sort((a, b) => toMin(a.start) - toMin(b.start));
      const dt = dates[i].toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      return `<div class="day${i === w.day ? " today" : ""}"><div class="day-h"><span class="day-name">${d}</span>${i === w.day ? '<span class="today-tag">TODAY</span>' : `<span class="day-date">${dt}</span>`}</div>` +
        (ss.length ? ss.map((s) => `<div class="slot ${esc(s.status)}"><span class="slot-time">${fmt(s.start)}${s.end ? " – " + fmt(s.end) : ""} ${esc(lbl)}</span>` +
          `<span class="slot-game">${esc(s.game || "TBA")}</span><div class="tags">${platTags(s.platform)}${fmtTags(s.format)}${s.status === "tentative" ? '<span class="tag st">Maybe</span>' : s.status === "cancelled" ? '<span class="tag">Cancelled</span>' : ""}</div>` +
          (s.notes ? `<span class="slot-notes">${esc(s.notes)}</span>` : "") + "</div>").join("") : '<span class="offday">No stream</span>') + "</div>";
    }).join("");
    renderCascade(lbl, w, dates);
    $("shelves").innerHTML = SHELVES.map((st) => {
      const gs = (S.games || []).filter((g) => g.status === st);
      return `<div class="shelf"><div class="shelf-h"><span>${st}</span><span>${gs.length}</span></div>` +
        (gs.length ? gs.map((g) => `<div class="game"><b>${esc(g.name)}</b>${g.notes ? `<span>${esc(g.notes)}</span>` : ""}</div>`).join("") : '<span class="small">Nothing here yet</span>') + "</div>";
    }).join("");
    const pt = S.patreon || {}, purl = safeUrl(S.links && S.links.patreon);
    $("patreonView").innerHTML = `<div class="patreon"><div class="patreon-hero"><h3>Patreon</h3><p>${esc(pt.blurb || "")}</p>` +
      (purl ? `<a class="btn btn-patreon" href="${esc(purl)}" target="_blank" rel="noopener">Join on Patreon</a>` : "") + "</div>" +
      `<div class="tiers">${(pt.tiers || []).map((t) => `<div class="tier"><b>${esc(t.name)}</b>${t.price ? `<span class="price">${esc(t.price)}</span>` : ""}<p>${esc(t.perks)}</p></div>`).join("")}</div></div>`;
    $("tzNote").textContent = `All times are ${lbl} (${tz().replace("_", " ")}).`;
    renderNext();
  }
  // Each stream is a window, cascading down and to the right from today. Click a title bar to open that window.
  let activeWin = "";
  function renderCascade(lbl, w, dates) {
    const order = (s) => ((+s.day - w.day + 7) % 7) * 1440 + toMin(s.start);
    const list = schedule().filter((s) => s.day >= 0 && s.day <= 6).slice().sort((a, b) => order(a) - order(b));
    const nx = nextStream();
    if (!list.some((s) => s.id === activeWin)) activeWin = (nx && nx.s.id) || (list[0] && list[0].id) || "";
    const box = $("cascade");
    box.style.setProperty("--n", Math.max(1, list.length));
    box.innerHTML = list.length ? list.map((s, i) => {
      const ahead = (+s.day - w.day + 7) % 7;      // the coming date for this stream, so past days show next week's date
      const dt = new Date(dates[w.day].getTime() + ahead * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      const live = nx && nx.live && nx.s === s, on = s.id === activeWin;
      const badge = live ? '<span class="win-badge live">LIVE</span>' : +s.day === w.day ? '<span class="win-badge">TODAY</span>' :
        s.status === "tentative" ? '<span class="win-badge maybe">MAYBE</span>' : s.status === "cancelled" ? '<span class="win-badge off">CANCELLED</span>' : "";
      return `<article class="win ${esc(s.status)}${on ? " front" : ""}" style="--i:${i}" data-id="${esc(s.id)}">` +
        `<button type="button" class="win-bar" aria-expanded="${on}"><span class="win-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
        `<span class="win-day">${DAYS[s.day]} · ${dt}</span><span class="win-title">${esc(s.game || "TBA")}</span>${badge}` +
        `<span class="win-time">${fmt(s.start)}${s.end ? " – " + fmt(s.end) : ""} ${esc(lbl)}</span></button>` +
        `<div class="win-body"><div class="win-in"><div class="win-game">${esc(s.game || "TBA")}</div>` +
        `<div class="tags">${platTags(s.platform)}${fmtTags(s.format)}${s.discord ? '<span class="tag dc">Discord event</span>' : ""}</div>` +
        (s.notes ? `<p class="win-notes">${esc(s.notes)}</p>` : "") +
        (s.link ? `<p class="win-notes"><a href="${esc(s.link)}" target="_blank" rel="noopener">Open the event in Discord ↗</a></p>` : "") +
        `<p class="win-when">${DAYS_LONG[s.day]}, ${fmt(s.start)}${s.end ? " to " + fmt(s.end) : ""} ${esc(lbl)}</p></div></div></article>`;
    }).join("") : '<p class="offday">No streams this week yet.</p>';
    const busy = new Set(list.map((s) => +s.day));
    const off = DAYS.filter((_, i) => !busy.has(i));
    $("offDays").textContent = off.length && list.length ? `No stream: ${off.join(" · ")}` : "";
  }
  function replayCascade() {
    const box = $("cascade"); box.classList.remove("play"); void box.offsetWidth; box.classList.add("play");
  }
  $("cascade").addEventListener("click", (e) => {
    const bar = e.target.closest(".win-bar"); if (!bar) return;
    const win = bar.parentElement; activeWin = win.dataset.id;
    $("cascade").querySelectorAll(".win").forEach((x) => { const on = x === win; x.classList.toggle("front", on); x.querySelector(".win-bar").setAttribute("aria-expanded", on); });
  });
  document.querySelector("#view-week .viewtoggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]"); if (!b) return;
    const grid = b.dataset.mode === "grid";
    document.querySelectorAll("#view-week .viewtoggle button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    $("week").hidden = !grid; $("cascade").hidden = grid; $("offDays").hidden = grid;
    if (!grid) replayCascade();
  });
  function renderNext() {
    const nx = nextStream(), lbl = S.tzLabel || "CT", card = $("nextCard");
    if (!nx) { card.innerHTML = '<span class="onair">NO STREAMS SET</span><div class="next-game">Check back soon</div>'; $("schedTeaser").textContent = "New schedule coming soon"; return; }
    const s = nx.s;
    const plat = s.platform === "Both" ? "Twitch + YouTube" : s.platform || "";
    let cd = "";
    if (!nx.live) {
      const left = Math.max(0, Math.floor((nx.at.getTime() - Date.now()) / 1000));
      const parts = [[Math.floor(left / 86400), "days"], [Math.floor(left % 86400 / 3600), "hrs"], [Math.floor(left % 3600 / 60), "min"], [left % 60, "sec"]];
      cd = `<div class="countdown">${parts.map(([v, u]) => `<div><b>${String(v).padStart(2, "0")}</b><span>${u}</span></div>`).join("")}</div>`;
    }
    let local = "";
    if (nx.at) {
      const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (mine && mine !== tz()) local = ` · ${nx.at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })} your time`;
    }
    card.innerHTML = `<span class="onair${nx.live ? " live" : ""}">${nx.live ? "● LIVE NOW" : "NEXT STREAM"}</span>` +
      `<div class="next-game">${esc(s.game || "TBA")}</div><div class="next-meta">${nx.title ? esc(nx.title) + "<br>" : ""}${DAYS_LONG[s.day]}${s.start ? " · " + fmt(s.start) : ""}${s.end ? " – " + fmt(s.end) : ""} ${s.start ? esc(lbl) : ""}${esc(local)}<br>${esc(plat)}</div>${cd}` +
      (nx.live ? `<div class="row"><a class="btn btn-a" href="#watch">Watch now</a></div>` : "");
    $("schedTeaser").textContent = nx.live ? `Live now: ${s.game || ""}` : `Next: ${DAYS[s.day]} ${fmt(s.start)} ${lbl} · ${s.game || "TBA"}`;
  }
  document.querySelector("#schedule .tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]"); if (!b) return;
    document.querySelectorAll("#schedule .tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
    ["week", "games", "patreon"].forEach((v) => { $("view-" + v).hidden = v !== b.dataset.view; });
  });

  // calendar file: one weekly repeating event per stream
  function ics() {
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date(), w = wall(now);
    const base = Date.UTC(w.y, w.m - 1, w.d);
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//flapvsjack//schedule//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:" + (S.channel || "Stream") + " streams",
      "BEGIN:VTIMEZONE", "TZID:America/Chicago", "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "TZNAME:CDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
      "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "TZNAME:CST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD", "END:VTIMEZONE"];
    const tzid = tz() === "America/Chicago" ? "America/Chicago" : tz();
    const link = safeUrl(S.links && S.links.twitch) || safeUrl(S.links && S.links.youtube) || location.href;
    for (const s of slotsLive()) {
      const ahead = s.date ? Math.max(0, daysUntil(s.date, w)) : (s.day - w.day + 7) % 7;   // this week's one, then every week (a Discord event: once)
      const d = new Date(base + ahead * 86400000);
      const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
      const st = toMin(s.start), en0 = toMin(s.end || s.start) || st + 120, en = en0 <= st ? en0 + 1440 : en0;
      const endDate = new Date(base + ahead * 86400000 + Math.floor(en / 1440) * 86400000);
      const ymdEnd = `${endDate.getUTCFullYear()}${pad(endDate.getUTCMonth() + 1)}${pad(endDate.getUTCDate())}`;
      const t = (m) => `${pad(Math.floor(m % 1440 / 60))}${pad(m % 60)}00`;
      const txt = (v) => String(v || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
      lines.push("BEGIN:VEVENT", `UID:${s.id || ymd + t(st)}-${(S.channel || "stream").replace(/\W/g, "")}@spooners`, "DTSTAMP:" + stamp,
        `DTSTART;TZID=${tzid}:${ymd}T${t(st)}`, `DTEND;TZID=${tzid}:${ymdEnd}T${t(en)}`, ...(s.date ? [] : ["RRULE:FREQ=WEEKLY"]),
        "SUMMARY:" + txt(`${S.channel || "Stream"}: ${s.game || "Live"}`), "DESCRIPTION:" + txt(`${s.platform || ""} ${s.notes || ""}`.trim() + "\n" + link),
        "URL:" + link, "STATUS:" + (s.status === "tentative" ? "TENTATIVE" : "CONFIRMED"),
        "BEGIN:VALARM", "TRIGGER:-PT15M", "ACTION:DISPLAY", "DESCRIPTION:" + txt(`${S.channel} goes live in 15 minutes`), "END:VALARM", "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }
  $("icsBtn").addEventListener("click", () => {
    const blob = new Blob([ics()], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${S.channel || "stream"}-schedule.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  window.__siteIcs = () => ics();   // used by tests

  // ---------------------------------------------------------------- watch
  let playerKind = "twitch";
  function renderPlayer() {
    const box = $("player"), host = location.hostname, wv = S.watch || {};
    if (playerKind === "twitch") {
      const ch = String(wv.twitchChannel || "").replace(/[^\w]/g, "");
      if (ch && host) box.innerHTML = `<iframe title="Twitch player" src="https://player.twitch.tv/?channel=${ch}&parent=${encodeURIComponent(host)}&muted=true&autoplay=false" allowfullscreen></iframe>`;
      else box.innerHTML = `<div class="ph"><div><h3>Twitch</h3><p>The player shows here once the site is online.</p>${safeUrl(S.links.twitch) ? `<a class="btn btn-a" href="${esc(S.links.twitch)}" target="_blank" rel="noopener">Open Twitch</a>` : ""}</div></div>`;
    } else {
      const id = String(wv.youtubeChannelId || "").replace(/[^\w-]/g, "");
      if (id) box.innerHTML = `<iframe title="YouTube live player" src="https://www.youtube.com/embed/live_stream?channel=${id}&mute=1" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
      else box.innerHTML = `<div class="ph"><div><h3>YouTube</h3><p>Catch the live stream and every video on the channel.</p>${safeUrl(S.links.youtube) ? `<a class="btn btn-a" href="${esc(S.links.youtube)}" target="_blank" rel="noopener">Open YouTube</a>` : ""}</div></div>`;
    }
  }
  document.querySelector("#watch .tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-player]"); if (!b || b.dataset.player === playerKind) return;
    playerKind = b.dataset.player;
    document.querySelectorAll("#watch .tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
    renderPlayer();
  });

  // ---------------------------------------------------------------- community
  function renderCommunity() {
    const g = S.goal || {};
    $("goalCard").hidden = g.show === false;
    const auto = g.auto && A && A.followers && A.followers.count != null;     // Cutroom keeps the follower count up to date
    const cur = Math.max(0, auto ? +A.followers.count : +g.current || 0), tgt = Math.max(1, +g.target || 1), pct = Math.min(100, Math.round((cur / tgt) * 100));
    $("goalCard").innerHTML = `<span class="label">${esc(g.label || "Community goal")}</span><h3>${esc(g.reward ? "Unlocks: " + g.reward : "")}</h3>` +
      `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${tgt}" aria-valuenow="${cur}"><i style="width:${pct}%"></i></div>` +
      `<div class="goalnums"><span>${cur.toLocaleString()} / ${tgt.toLocaleString()}</span><span>${tgt - cur > 0 ? (tgt - cur).toLocaleString() + " to go" : "Goal reached!"}</span></div>`;
    const so = S.shoutout || {};
    $("shoutCard").hidden = so.show === false || !so.name;
    $("shoutCard").innerHTML = `<span class="label">${esc(so.title || "Spooner of the week")}</span><div class="bigname">${esc(so.name)}</div>` +
      (so.reason ? `<p style="margin:0">${esc(so.reason)}</p>` : "") +
      ((so.extra || []).length ? `<div class="extra">${so.extra.map((x) => `<span>${esc(x.label)}: <b>${esc(x.name)}</b></span>`).join("")}</div>` : "");
    const v = S.vote || {};
    $("voteCard").hidden = v.show === false || !(v.options || []).length;
    const total = (v.options || []).reduce((n, o) => n + (+o.votes || 0), 0);
    const top = Math.max(0, ...(v.options || []).map((o) => +o.votes || 0));
    $("voteCard").innerHTML = `<span class="label">Game vote</span><h3>${esc(v.question || "What should we play next?")}</h3><div class="vote">` +
      (v.options || []).map((o) => { const n = +o.votes || 0, p = total ? Math.round((n / total) * 100) : 0;
        return `<div class="vrow${n && n === top ? " top" : ""}"><b>${esc(o.name)}</b><span>${n} vote${n === 1 ? "" : "s"} · ${p}%</span><div class="vb"><i style="width:${p}%"></i></div></div>`; }).join("") +
      `</div><div class="row"><span class="small">${esc(v.how || "")}</span>${discordUrl() ? `<a class="btn btn-discord" href="${esc(discordUrl())}" target="_blank" rel="noopener">Vote in Discord</a>` : ""}</div>`;
    const clips = (S.clips || []).filter((c) => safeUrl(c.url));
    $("clipsWrap").hidden = !clips.length;
    $("clips").innerHTML = clips.map((c) => `<a class="clip" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener"><div class="thumb${c.kind === "short" ? " vertical" : ""}">${esc(c.kind === "vod" ? "VOD" : c.kind === "short" ? "Short" : "Clip")}</div>` +
      `<div class="cb"><b>${esc(c.title || "Watch")}</b>${c.note ? `<span class="small">${esc(c.note)}</span>` : ""}</div></a>`).join("");
  }

  // ---------------------------------------------------------------- map + pin yourself
  const CONT = {
    "Africa": "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW",
    "Asia": "AF AM AZ BH BD BT BN KH CN CY GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE",
    "Europe": "AL AD AT BY BE BA BG HR CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA GI FO IM JE GG",
    "North America": "US CA MX AG BS BB BZ CR CU DM DO SV GD GT HT HN JM NI PA KN LC VC TT PR GL BM KY AW CW",
    "South America": "AR BO BR CL CO EC GY PY PE SR UY VE GF FK",
    "Oceania": "AU NZ FJ KI MH FM NR PW PG WS SB TO TV VU GU NC PF",
    "Antarctica": "AQ",
  };
  let regionName = (c) => c;
  try { const dn = new Intl.DisplayNames(["en"], { type: "region" }); regionName = (c) => dn.of(c) || c; } catch (e) { /* old browser */ }
  const continentOf = (code) => Object.keys(CONT).find((k) => CONT[k].split(" ").includes(String(code || "").toUpperCase())) || "";
  function fillCountries(cont) {
    const codes = cont ? CONT[cont].split(" ") : Object.values(CONT).join(" ").split(" ");
    $("countryList").innerHTML = codes.map(regionName).sort().map((n) => `<option value="${esc(n)}"></option>`).join("");
  }
  function guessFromBrowser() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const region = (navigator.language || "").split("-")[1] || "";
    let cont = continentOf(region);
    if (!cont) {
      const top = zone.split("/")[0];
      cont = { Europe: "Europe", Africa: "Africa", Asia: "Asia", Australia: "Oceania", Pacific: "Oceania", Antarctica: "Antarctica" }[top] ||
        (top === "America" ? (/Sao_Paulo|Argentina|Bogota|Lima|Santiago|Caracas|Montevideo|Asuncion|La_Paz|Guayaquil|Manaus|Recife|Fortaleza|Belem|Cayenne|Paramaribo|Guyana/.test(zone) ? "South America" : "North America") : "");
    }
    return { cont, country: region && continentOf(region) ? regionName(region) : "" };
  }
  function renderMap() {
    const m = S.map || {};
    $("mapBlurb").textContent = m.blurb || "";
    const mid = String(m.mid || "").replace(/[^\w-]/g, "");
    $("mapFrame").innerHTML = mid ? `<iframe title="Spooners map" src="https://www.google.com/maps/d/embed?mid=${mid}" loading="lazy"></iframe>` : "";
    $("mapFrame").hidden = !mid;
    const sel = $("pinContinent");
    if (!sel.options.length) {
      sel.innerHTML = '<option value="">Choose…</option>' + Object.keys(CONT).map((c) => `<option>${c}</option>`).join("");
      const g = guessFromBrowser(); if (g.cont) sel.value = g.cont; if (g.country) $("pinCountry").value = g.country;
      fillCountries(sel.value);
      sel.addEventListener("change", () => fillCountries(sel.value));
    }
    const ready = !!safeUrl(m.scriptUrl);
    let done = false; try { done = localStorage.getItem("spooner-pinned") === "1"; } catch (e) { /* storage off */ }
    $("pinSubmit").disabled = !ready;
    if (!ready) msg("Map sign-ups open soon.", "");
    else if (done) msg("You're already on the map. Thanks, Spooner!", "ok");
    loadTally();
  }
  function msg(t, cls) { const p = $("pinMsg"); p.textContent = t; p.className = "formmsg " + (cls || ""); }
  $("pinLocate").addEventListener("click", () => {
    if (!navigator.geolocation) { msg("Your browser can't share a location. Fill it in by hand.", "bad"); return; }
    msg("Finding you…", "");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=5&addressdetails=1&accept-language=en&lat=${latitude.toFixed(2)}&lon=${longitude.toFixed(2)}`);
        const j = await r.json(), a = j.address || {}, cc = String(a.country_code || "").toUpperCase();
        const cont = continentOf(cc);
        if (cont) { $("pinContinent").value = cont; fillCountries(cont); }
        $("pinCountry").value = a.country || (cc ? regionName(cc) : "");
        $("pinState").value = a.state || a.province || a.region || a.county || "";
        msg("Filled in. Only your continent, country and state are saved.", "ok");
      } catch (e) { msg("Couldn't look up your area. Fill it in by hand.", "bad"); }
    }, () => msg("Location wasn't shared. Fill it in by hand.", "bad"), { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  });
  $("pinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = safeUrl(S.map && S.map.scriptUrl); if (!url) return;
    const data = { name: $("pinName").value.trim().slice(0, 40), continent: $("pinContinent").value, country: $("pinCountry").value.trim().slice(0, 60), state: $("pinState").value.trim().slice(0, 60) };
    if (!data.continent || !data.country) { msg("Choose your continent and country.", "bad"); return; }
    $("pinSubmit").disabled = true; msg("Adding you…", "");
    try {
      await fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(data) });
      try { localStorage.setItem("spooner-pinned", "1"); } catch (e2) { /* storage off */ }
      msg("You're on the list! Your pin shows up on the map soon.", "ok");
      setTimeout(loadTally, 2500);
    } catch (err) { msg("Couldn't send it. Check your connection and try again.", "bad"); }
    $("pinSubmit").disabled = false;
  });
  async function loadTally() {
    const url = safeUrl(S.map && S.map.scriptUrl); if (!url) { $("tally").hidden = true; return; }
    try {
      const r = await fetch(url + (url.includes("?") ? "&" : "?") + "action=tally", { cache: "no-store" });
      const j = await r.json();
      const rows = (j.regions || []).slice(0, 24);
      if (!rows.length) { $("tally").hidden = true; return; }
      $("tally").innerHTML = `<span><b>${+j.total || 0}</b> Spooners pinned</span>` + rows.map((x) => `<span>${esc(x.name)} <b>${+x.count || 0}</b></span>`).join("");
      $("tally").hidden = false;
    } catch (e) { $("tally").hidden = true; }
  }

  // ---------------------------------------------------------------- support + links
  function renderSupport() {
    $("supportGrid").innerHTML = (S.support || []).filter((s) => safeUrl(s.url)).map((s) =>
      `<div class="scard"><h3>${esc(s.name)}</h3><p>${esc(s.perk || "")}</p><a class="btn btn-a" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.button || "Support on " + s.name)}</a></div>`).join("");
  }
  function renderLinks() { $("heroLinks").innerHTML = linkChips(); $("footLinks").innerHTML = linkChips(); setDiscordButtons(); }

  // ---------------------------------------------------------------- everything
  function renderLive() {
    const lv = liveNow(), bar = $("liveBanner"); if (!bar) return;
    bar.hidden = !lv; document.body.classList.toggle("is-live", !!lv);
    if (!lv) return;
    const url = safeUrl(lv.url) || safeUrl((S.links || {}).twitch);
    bar.innerHTML = `<span class="lb-dot"></span><b>LIVE NOW</b><span class="lb-t">${esc(lv.title || "")}${lv.game ? `<span class="lb-g"> · ${esc(lv.game)}</span>` : ""}</span>` +
      `<a class="btn btn-white" href="#watch">Watch here</a>${url ? `<a class="btn btn-a lb-tw" href="${esc(url)}" target="_blank" rel="noopener">Open Twitch</a>` : ""}`;
  }
  // News: your posts (Cutroom › Webpage › News & updates) and new Discord events, newest first
  function newsPosts() {
    const lbl = S.tzLabel || "CT";
    const own = (S.posts || []).filter((p) => p && (p.title || p.text)).map((p) => ({ kind: p.kind === "update" ? "update" : "news", title: p.title || "", text: p.text || "",
      date: /^\d{4}-\d{2}-\d{2}$/.test(p.date || "") ? p.date : "", link: safeUrl(p.link) }));
    const ev = S.discordSync === false ? [] : ((A && A.events) || []).filter((e) => e && e.date).map((e) => {
      const w = wall(new Date((+e.first || 0) * 1000));
      return { kind: "stream", title: e.name || "Stream", text: e.notes || "", link: safeUrl(e.link), date: todayStr(w),
        when: `${DAYS_LONG[+e.day] || ""}, ${monthDay(e.date)} · ${fmt(e.start)}${e.end ? " – " + fmt(e.end) : ""} ${lbl}` };
    });
    return own.concat(ev).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 6);
  }
  const monthDay = (ymd) => { const [y, m, d] = String(ymd || "").split("-").map(Number); return y ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : ""; };
  function renderNews() {
    const box = $("newsGrid"), band = $("news"); if (!box || !band) return;
    const posts = newsPosts(); band.hidden = !posts.length;
    const LABEL = { stream: "New stream", update: "Spooners update", news: "News" };
    box.innerHTML = posts.map((p) => `<article class="news news-${p.kind}"><div class="news-top"><span class="pill${p.kind === "stream" ? "" : " pill-soft"}">${LABEL[p.kind]}</span>` +
      `${p.date ? `<span class="news-date">${esc(monthDay(p.date))}</span>` : ""}</div><h3>${esc(p.title)}</h3>` +
      (p.when ? `<p class="news-when">${esc(p.when)}</p>` : "") + (p.text ? `<p class="news-text">${esc(p.text)}</p>` : "") +
      (p.link ? `<a class="btn btn-a" href="${esc(p.link)}" target="_blank" rel="noopener">${p.kind === "stream" ? "Open the Discord event" : "Read more"}</a>` : "") + "</article>").join("");
  }
  function renderGallery() {    // pictures and videos sent from Cutroom ("Send to… › Website gallery")
    const g = (S.gallery || []).filter((x) => x && /^assets\/gallery\/[^/]+$/.test(x.src || ""));
    const wrap = $("galleryWrap"); if (!wrap) return;
    wrap.hidden = !g.length;
    $("gallery").innerHTML = g.map((x) => x.kind === "video"
      ? `<figure class="gal"><video src="${esc(x.src)}" controls preload="metadata" playsinline></video>${x.title ? `<figcaption>${esc(x.title)}</figcaption>` : ""}</figure>`
      : `<figure class="gal"><a href="${esc(x.src)}" target="_blank" rel="noopener"><img src="${esc(x.src)}" alt="${esc(x.title || "")}" loading="lazy"></a>${x.title ? `<figcaption>${esc(x.title)}</figcaption>` : ""}</figure>`).join("");
  }
  function renderAll() {
    applyTheme();
    document.title = `${S.channel || "flapvsjack"} · ${S.community || "OnionS Spoon Alliance"}`;
    $("brandName").textContent = S.channel || "flapvsjack"; $("footName").textContent = `${S.channel || ""} · ${S.community || ""}`;
    renderLinks(); renderHub(); renderDiscord(); renderSchedule(); renderPlayer(); renderCommunity(); renderMap(); renderSupport(); renderLive(); renderGallery(); renderNews();
    layout(false);
  }
  function start(data) {
    const widget = S && S._widget;
    S = data; if (widget) S._widget = widget;
    renderAll();
    if (!widget) loadWidget();
    clearInterval(tick); tick = setInterval(renderNext, 1000);
  }
  addEventListener("message", (e) => {   // live preview from Cutroom (same PC only)
    if (e.data && e.data.type === "site-data" && e.data.data && /^(http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(e.origin)) start(e.data.data);
  });
  const want = location.hash.replace("#", "");
  const loadAuto = () => fetch("data/auto.json?t=" + Date.now(), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([fetch("data/site.json", { cache: "no-store" }).then((r) => r.json()), loadAuto()]).then(([d, a]) => {
    A = a; start(d);
    if (panels[want]) openPanel(want);
    setInterval(() => { if (document.hidden) return; fetch("data/site.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json())
      .then((n) => { if (JSON.stringify(n.live || null) !== JSON.stringify(S.live || null)) { S.live = n.live; renderLive(); renderNext(); } }).catch(() => {});
      loadAuto().then((a2) => { if (a2 && JSON.stringify(a2) !== JSON.stringify(A)) { A = a2; renderSchedule(); renderCommunity(); renderNews(); } }); }, 120000);
  }).catch(() => { document.body.insertAdjacentHTML("afterbegin", '<p style="padding:12px;background:#fde8e8;margin:0">The schedule couldn\'t load. Refresh the page to try again.</p>'); });
})();
