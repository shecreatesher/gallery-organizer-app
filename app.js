/* Gallery Organizer: one-screen flow, steps 1 and 2.
   Add photos and folders → they gather into a ball → Sort sends each photo
   flying into its year folder. Steps 3 (duplicates) and 4 (create) live in flow.js,
   which takes over the primary button once sorting is done. */
(function () {
  "use strict";
  const S = window.GalleryScan;
  const M = window.GalleryMeta;
  const $ = id => document.getElementById(id);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const BALL_MAX = matchMedia("(max-width: 600px)").matches ? 48 : 96;   // photos shown in the ball (fewer on phones: lighter to draw)
  const CARD_SLOTS = 12;        // folder places around the ball
  const SOURCE_COLORS = ["#E9A23B", "#3B8FE9", "#E9573B", "#2FB57C", "#9B5DE5", "#E93B8F", "#3BC4E9", "#8A6E4B"];
  const YEAR_COLORS = ["#E9573B", "#E9A23B", "#2FB57C", "#3B8FE9", "#9B5DE5", "#E93B8F", "#3BC4E9", "#C9822B", "#5E9E3B", "#5B6EE9", "#B5483B", "#8A6E4B"];

  const state = {
    phase: "empty",   // empty | reading | ready | sorting | done
    paused: false,    // finding photos is on hold (Pause); Stop ends it instead
    roots: [],        // {id, name, handle, loose, photos, videos, scanning, controller, color}
    files: [],        // records from scan.js, plus date/dateSource from meta.js
    skipped: [],
    folders: [],      // after sorting: the cards around the ball, {key, name, files, color, card}
    range: { kind: "all", from: null, to: null },  // which photos: all, this year, last 12 months, last 3 years, or picked dates
    layers: ["year"], // how to sort: one or two of "year", "month", "country", e.g. ["year", "country"] → 2024/Spain/
    targets: 0        // how many folders the new library will have
  };
  window.GalleryState = state;

  const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  const supportsPicker = typeof window.showDirectoryPicker === "function" && !inFrame;
  if (inFrame) showNotice("Online preview: your photos are read by your browser only. If Chrome asks to “Upload”, that only lets this page read them.");
  else if (!supportsPicker) { $("foot").textContent = "Designed for computers. Private by design: your photos never leave this device."; $("foot").classList.add("strong"); }

  let nextId = 1;
  const fmt = n => n.toLocaleString();
  const count = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

  /* =========================================================
     Adding photos
     ========================================================= */

  const metaQueue = M.createQueue(rec => { rec.dated = true; queueRender(); });

  function setMenu(open) {
    $("sourceMenu").hidden = !open;
    $("sourceBtn").setAttribute("aria-expanded", String(open));
    if (open) $("sourceMenu").querySelector("[data-add]").focus();
  }
  $("sourceBtn").addEventListener("click", e => { e.stopPropagation(); setMenu($("sourceMenu").hidden); });
  $("sourceMenu").addEventListener("click", e => {
    const b = e.target.closest("[data-add]");
    if (!b) return;
    setMenu(false);
    if (b.dataset.add === "photos") $("photoPicker").click(); else pickFolder();
  });
  document.addEventListener("click", e => { if (!e.target.closest(".source")) setMenu(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sourceMenu").hidden) { setMenu(false); $("sourceBtn").focus(); } });
  $("orbEmpty").addEventListener("click", e => { e.stopPropagation(); setMenu(true); });

  /* Pause, resume and stop while photos are being found.
     Pause holds every folder scan at its next file; Stop ends them and keeps what was found. */
  let resumeWaiters = [];
  const waitIfPaused = () => state.paused ? new Promise(r => resumeWaiters.push(r)) : null;
  function setPaused(on) {
    state.paused = on;
    if (!on) { const w = resumeWaiters; resumeWaiters = []; w.forEach(r => r()); }
    queueRender();
  }
  function stopScanning() {
    const scanning = state.roots.filter(r => r.scanning);
    if (!scanning.length) return;
    for (const root of scanning) { root.stopped = true; root.scanning = false; root.controller.abort(); }
    setPaused(false);
    const kept = scanning.reduce((n, r) => n + r.photos + r.videos, 0);
    toast(`Stopped. ${count(kept, "item", "items")} kept; the rest of ${scanning.length === 1 ? scanning[0].name : "those folders"} wasn't added.`);
  }
  $("pauseBtn").addEventListener("click", () => setPaused(!state.paused));
  $("stopBtn").addEventListener("click", stopScanning);

  function newRoot(name, handle) {
    if (state.paused) setPaused(false);   // adding something new carries on
    const root = { id: nextId++, name, handle, loose: false, photos: 0, videos: 0, scanning: true, controller: new AbortController(), color: SOURCE_COLORS[(nextId - 2) % SOURCE_COLORS.length] };
    beforeChange();
    state.roots.push(root);
    queueRender();
    return root;
  }

  function addRecord(root, rec) {
    state.files.push(rec);
    if (rec.kind === "photo") root.photos++; else root.videos++;
    Ball.add(rec);
    ballKey = null;   // the ball now shows every photo found, whatever the time range
    metaQueue.add(rec);
    queueRender();
  }

  // Adding or removing anything after a sort starts a fresh plan.
  function beforeChange() {
    if (state.phase === "done" || state.phase === "sorting") resetSort();
  }

  /* Single photos */
  function looseRoot() {
    let root = state.roots.find(r => r.loose);
    if (!root) { root = newRoot("Selected photos", null); root.loose = true; root.keys = new Set(); root.scanning = false; }
    else beforeChange();
    return root;
  }
  async function addLooseFiles(files) {
    files = [...files].filter(Boolean);
    if (!files.length) return;
    const root = looseRoot();
    let added = 0, ignored = 0, repeated = 0;
    for (const file of files) {
      await S.breathe();
      const rec = S.fileRecord(root.id, file, "Selected photos/" + file.name);
      if (!rec) { ignored++; continue; }
      const key = file.name + "|" + file.size + "|" + file.lastModified;
      if (root.keys.has(key)) { repeated++; continue; }
      root.keys.add(key);
      addRecord(root, rec);
      added++;
    }
    if (!root.photos && !root.videos) removeRoot(root.id, true);
    const notes = [];
    if (ignored) notes.push(`${count(ignored, "file isn't", "files aren't")} a photo or video`);
    if (repeated) notes.push(`${count(repeated, "was", "were")} already added`);
    if (notes.length) toast(`Added ${count(added, "item", "items")}. ${notes.join(", ")}.`);
  }
  $("photoPicker").addEventListener("change", e => { picking = false; addLooseFiles(e.target.files); e.target.value = ""; });
  // On phones the system copies (and converts) every picked photo before the page gets them, which can
  // take a while. Say so as soon as the picker closes, so the page never looks frozen.
  let picking = false;
  $("photoPicker").addEventListener("click", () => { picking = true; });
  $("photoPicker").addEventListener("cancel", () => { picking = false; render(); });
  const pickerClosed = () => {
    if (!picking || document.hidden) return;
    setTimeout(() => { if (picking) { caption("Getting your photos…"); status("run", "Getting photos"); } }, 300);
  };
  window.addEventListener("focus", pickerClosed);
  document.addEventListener("visibilitychange", pickerClosed);

  /* Folders */
  async function pickFolder() {
    if (!supportsPicker) { $("fallbackPicker").click(); return; }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: "gallery-source", mode: "read" });
    } catch (err) {
      if (err && err.name === "SecurityError") { $("fallbackPicker").click(); return; }
      if (err && err.name !== "AbortError") toast("Couldn't open that folder. Try another one.");
      return;
    }
    await addHandle(handle);
  }

  async function addHandle(handle) {
    for (const root of state.roots) {
      const rel = await S.relation(root.handle, handle);
      if (rel === "same") { toast(`${handle.name} is already added`); return; }
      if (rel === "inside") { toast(`${handle.name} is already included in ${root.name}`); return; }
      if (rel === "contains") { removeRoot(root.id, true); toast(`${root.name} is inside ${handle.name}, so it was replaced`); }
    }
    const root = newRoot(handle.name, handle);
    await S.scanDirectory(handle, {
      rootId: root.id, signal: root.controller.signal, waitIfPaused,
      onFile: rec => addRecord(root, rec),
      onSkip: sk => { state.skipped.push({ ...sk, rootId: root.id }); queueRender(); }
    });
    if (!root.controller.signal.aborted) { root.scanning = false; queueRender(); }
  }

  $("fallbackPicker").addEventListener("change", async e => {
    const list = e.target.files;
    if (!list || !list.length) return;
    const root = newRoot("", null);
    const { rootName, records } = await S.fromFileList(list, root.id);
    e.target.value = "";
    root.name = rootName || "Folder";
    for (const r of records) {
      await S.breathe();
      await waitIfPaused();
      if (root.controller.signal.aborted) break;
      addRecord(root, r);
    }
    if (!root.stopped) root.scanning = false;
    queueRender();
  });

  function addEntry(entry) {
    const root = newRoot(entry.name, null);
    S.scanEntry(entry, {
      rootId: root.id, signal: root.controller.signal, waitIfPaused,
      onFile: rec => addRecord(root, rec),
      onSkip: sk => { state.skipped.push({ ...sk, rootId: root.id }); queueRender(); }
    }).then(() => { root.scanning = false; queueRender(); });
  }

  function removeRoot(id, quiet) {
    const root = state.roots.find(r => r.id === id);
    if (!root) return;
    beforeChange();
    root.controller.abort();
    state.files.forEach(f => { if (f.rootId === id) f.removed = true; });
    if (state.paused && !state.roots.some(r => r.scanning && r.id !== id)) setPaused(false);
    state.roots = state.roots.filter(r => r.id !== id);
    state.files = state.files.filter(f => f.rootId !== id);
    state.skipped = state.skipped.filter(s => s.rootId !== id);
    Ball.rebuild(chosen()); ballKey = rangeKey();
    if (!quiet) toast(`Removed ${root.name}`);
    queueRender();
  }

  /* Drag and drop: photos, folders or both */
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  window.addEventListener("dragenter", e => { if (hasFiles(e) && state.phase !== "sorting") { dragDepth++; $("dropzone").hidden = false; } });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropzone").hidden = true; });
  window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $("dropzone").hidden = true;
    if (state.phase === "sorting") return;
    const items = [...e.dataTransfer.items].filter(i => i.kind === "file");
    const loose = [];
    // Read every item now: the browser clears them once this handler awaits.
    if (supportsPicker && items.length && typeof items[0].getAsFileSystemHandle === "function") {
      const handles = await Promise.all(items.map(i => i.getAsFileSystemHandle().catch(() => null)));
      for (const h of handles) {
        if (!h) continue;
        if (h.kind === "directory") await addHandle(h); else loose.push(await h.getFile());
      }
    } else if (items.length && typeof items[0].webkitGetAsEntry === "function") {
      for (const entry of items.map(i => i.webkitGetAsEntry())) {
        if (!entry) continue;
        if (entry.isDirectory) addEntry(entry);
        else loose.push(await new Promise(res => entry.file(res, () => res(null))));
      }
    } else {
      loose.push(...e.dataTransfer.files);
    }
    addLooseFiles(loose);
  });

  /* =========================================================
     The photo ball
     ========================================================= */

  const Ball = (() => {
    const orb = $("orb");
    let tiles = [];            // {rec, el, url, tx,ty,tz (place on sphere), x,y,z,s (current), k (glide speed), squash}
    let left = [];             // tiles that flew out while sorting (their pictures stay in use until cleared)
    let angle = 0, tilt = -0.25;
    const spin = 0.0035;
    let size = orb.clientWidth || 400;
    let running = false;
    let dragging = false, lastX = 0, lastY = 0;
    let seen = 0;              // photos offered to the ball, for fair sampling

    function thumb(el, rec) {
      el._rec = null;
      if (rec.kind === "photo" && S.canPreview(rec.name)) {
        // a small picture, made in the background; the tile shows plain paper until it's ready
        el._rec = rec;
        el.style.backgroundImage = rec.thumbUrl ? `url("${rec.thumbUrl}")` : "";
        if (!rec.thumbUrl) S.thumb(rec, () => el._rec === rec && el.isConnected).then(u => { if (u && el._rec === rec) el.style.backgroundImage = `url("${u}")`; });
        return null;
      }
      let h = 0;
      for (const c of rec.name) h = (h * 31 + c.charCodeAt(0)) % 360;
      el.style.backgroundImage = `linear-gradient(160deg, hsl(${h} 45% 58%), hsl(${(h + 40) % 360} 40% 30%))`;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = rec.ext.toUpperCase();
      el.appendChild(lbl);
      return null;
    }

    // Even places on the sphere (a golden spiral). nearest: each photo takes the closest free place
    // instead of the place with its number, so the ball closes up gently when photos leave.
    function layout(nearest) {
      const n = tiles.length, golden = Math.PI * (3 - Math.sqrt(5));
      const spots = [];
      for (let i = 0; i < n; i++) {
        const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), th = i * golden;
        spots.push([Math.cos(th) * r, y, Math.sin(th) * r]);
      }
      if (!nearest) tiles.forEach((t, i) => { [t.tx, t.ty, t.tz] = spots[i]; });
      else {
        const free = new Set(spots.keys());
        for (const t of tiles) {
          let best = -1, bestD = Infinity;
          for (const i of free) {
            const s = spots[i], d = (s[0] - t.tx) ** 2 + (s[1] - t.ty) ** 2 + (s[2] - t.tz) ** 2;
            if (d < bestD) { bestD = d; best = i; }
          }
          free.delete(best);
          [t.tx, t.ty, t.tz] = spots[best];
        }
      }
      // fewer photos → bigger photos, so a small pool still looks full
      const ts = n <= 8 ? 24 : n >= 60 ? 15 : 24 - (n - 8) * (9 / 52);
      orb.style.setProperty("--ts", ts.toFixed(1) + "%");
    }

    // Put a different photo on an existing tile. flip: a quick squeeze, so a new photo is seen arriving.
    function setRec(t, rec, flip) {
      const swap = () => {
        if (t.url) URL.revokeObjectURL(t.url);
        t.el.textContent = "";
        t.el.className = "tile" + (rec.kind === "video" ? " vid" : "");
        t.rec = rec;
        t.url = thumb(t.el, rec);
      };
      if (!flip || reduceMotion) return swap();
      t.squash = 0.5;
      setTimeout(swap, 90);
    }

    function add(rec) {
      seen++;
      if (tiles.length >= BALL_MAX) {
        // Keep the ball a fair random sample of everything added (reservoir sampling).
        // A swapped photo on the front side flips, so the ball keeps visibly filling.
        const j = Math.floor(Math.random() * seen);
        if (j < BALL_MAX) setRec(tiles[j], rec, tiles[j].depth > 0.55);
        return;
      }
      const el = document.createElement("div");
      el.className = "tile" + (rec.kind === "video" ? " vid" : "");
      const url = thumb(el, rec);
      orb.appendChild(el);
      // Budding: a new photo grows out of one already in the ball, which gives a little squeeze,
      // then glides to its own place while the others shift to make room. The first one grows from the middle.
      const parent = tiles.length ? tiles[Math.floor(Math.random() * tiles.length)] : null;
      if (parent) parent.squash = 0.22;
      tiles.push(parent
        ? { rec, el, url, x: parent.x, y: parent.y, z: parent.z, s: 1, k: 0.07, squash: 0, depth: parent.depth }
        : { rec, el, url, x: 0, y: 0, z: 0, s: 0, k: 0.12, squash: 0, depth: 0 });
      layout();
      $("orbEmpty").hidden = true;
      start();
    }

    function clear() {
      tiles.concat(left).forEach(t => { t.el.remove(); if (t.url) URL.revokeObjectURL(t.url); });
      tiles = []; left = [];
      seen = 0;
      orb.querySelectorAll(".done-badge").forEach(n => n.remove());
    }

    function rebuild(files) {
      clear();
      files.forEach(add);
      $("orbEmpty").hidden = tiles.length > 0;
      draw();
    }

    function project(t) {
      const ca = Math.cos(angle), sa = Math.sin(angle), ct = Math.cos(tilt), st = Math.sin(tilt);
      const x1 = t.x * ca + t.z * sa, z1 = -t.x * sa + t.z * ca;
      return { x: x1, y: t.y * ct - z1 * st, z: t.y * st + z1 * ct };
    }

    function draw() {
      const R = size * 0.33;
      for (const t of tiles) {
        // ease each tile toward its place (new photos grow out of the middle)
        const k = reduceMotion ? 1 : (t.k || 0.12);
        t.x += (t.tx - t.x) * k; t.y += (t.ty - t.y) * k; t.z += (t.tz - t.z) * k; t.s += (1 - t.s) * k;
        t.squash = reduceMotion ? 0 : (t.squash || 0) * 0.86;
        const p = project(t);
        const depth = (p.z + 1) / 2;
        const scale = (0.55 + 0.5 * depth) * t.s * (1 - t.squash);
        t.el.style.transform = `translate(${(p.x * R).toFixed(1)}px, ${(p.y * R).toFixed(1)}px) scale(${scale.toFixed(3)})`;
        t.el.style.zIndex = String(Math.round(depth * 1000));
        t.el.style.opacity = (0.55 + 0.45 * depth).toFixed(2);
        t.depth = depth;
      }
    }

    function frame() {
      if (!running) return;
      if (!reduceMotion && !dragging) angle += spin;
      draw();
      requestAnimationFrame(frame);
    }
    function start() { if (!running) { running = true; requestAnimationFrame(frame); } }

    // Drag to spin
    orb.addEventListener("pointerdown", e => {
      if (!tiles.length || e.target.closest(".orb-empty")) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      orb.setPointerCapture(e.pointerId);
    });
    orb.addEventListener("pointermove", e => {
      if (!dragging) return;
      angle += (e.clientX - lastX) * 0.01;
      tilt = Math.max(-1.1, Math.min(1.1, tilt + (e.clientY - lastY) * 0.006));
      lastX = e.clientX; lastY = e.clientY;
    });
    const stopDrag = () => { dragging = false; };
    orb.addEventListener("pointerup", stopDrag);
    orb.addEventListener("pointercancel", stopDrag);
    new ResizeObserver(() => { size = orb.clientWidth || size; draw(); }).observe(orb);

    // The front-most photo still in the ball: the next one to fly
    function takeFront() {
      let best = null;
      for (const t of tiles) if (!t.gone && (!best || t.depth > best.depth)) best = t;
      if (best) best.gone = true;
      return best;
    }

    // A photo has left for its folder: take it out of the ball and let the rest close the gap,
    // so the ball shrinks evenly (photos get bigger as fewer remain) instead of filling with holes.
    function release(t) {
      const i = tiles.indexOf(t);
      if (i < 0) return;
      tiles.splice(i, 1);
      left.push(t);
      t.el.remove();
      for (const o of tiles) o.k = 0.1;
      if (tiles.length) layout(true);
    }

    return { add, rebuild, clear, draw, takeFront, release, setRec, get tiles() { return tiles; } };
  })();

  /* =========================================================
     Folder cards around the ball
     ========================================================= */

  const cardSpots = [];
  function buildPlaceholders() {
    $("colLeft").innerHTML = ""; $("colRight").innerHTML = "";
    cardSpots.length = 0;
    for (let i = 0; i < CARD_SLOTS; i++) {
      const el = document.createElement("div");
      el.className = "fcard";
      // rows run across the screen: two cards on the left, then two on the right
      ((i % 4) < 2 ? $("colLeft") : $("colRight")).appendChild(el);
      cardSpots.push(el);
    }
  }

  function makeCard(spot, folder) {
    spot.className = "fcard live";
    spot.style.setProperty("--fc", folder.color);
    spot.innerHTML = `<div class="f-head"><span class="f-ico" aria-hidden="true"></span><span class="f-name"></span><span class="f-count">0</span></div><div class="slots">${'<i class="slot"></i>'.repeat(6)}</div><p class="f-sub"></p>`;
    spot.querySelector(".f-name").textContent = folder.name;
    spot.querySelector(".f-sub").textContent = folder.sub || "";
    folder.card = { el: spot, count: spot.querySelector(".f-count"), slots: [...spot.querySelectorAll(".slot")], shown: 0, landed: 0 };
  }

  /* =========================================================
     Sorting
     ========================================================= */

  /* Where each photo goes in the new library: one or two layers, each Year, Month or Country.
       Year            → 2024/
       Month           → 2024-03 March/            (inside a year: 03 March/)
       Country         → Spain/                    (no GPS: Unknown country/)
     The first layer is the cards around the ball; the second layer is the folders inside each card. */
  const UNKNOWN_COUNTRY = "Unknown country";
  // rec.place is "Spain - Madrid"; the country is the part before the dash
  const countryOf = place => (place ? place.split(" - ")[0] : null);
  const LAYER_WORDS = { year: ["year", "years"], month: ["month", "months"], country: ["country", "countries"] };
  const pad2 = n => String(n).padStart(2, "0");
  const monthName = d => { const m = d.toLocaleString(undefined, { month: "long" }); return m.charAt(0).toUpperCase() + m.slice(1); };
  // Folder names safe on Mac, Windows and Linux
  const safeName = s => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^[\s.]+|[\s.]+$/g, "");
  function layerName(f, layer, inYear) {
    if (layer === "year") return String(f.date.getFullYear());
    if (layer === "month") return `${inYear ? "" : f.date.getFullYear() + "-"}${pad2(f.date.getMonth() + 1)} ${monthName(f.date)}`;
    return (f.place && safeName(countryOf(f.place))) || UNKNOWN_COUNTRY;
  }
  function targetOf(f) {
    f.special = specialOf(f);
    if (f.special) return `${f.special}/${f.date.getFullYear()}`;
    const [a, b] = state.layers;
    return b ? `${layerName(f, a)}/${layerName(f, b, a === "year")}` : layerName(f, a);
  }
  // Allowed second layers: anything but the first, and no year inside a month (the month already has it)
  const secondOptions = first => ["year", "month", "country"].filter(l => l !== first && !(first === "month" && l === "year"));
  const layersText = () => state.layers.join(" and ");
  const hasCountry = () => state.layers.includes("country");

  /* Kept apart automatically, whatever the sort: Screenshots/2024/ and Documents/2024/.
     Screenshots: the name says so (in many languages), or a PNG (cameras never save PNG; phones save screenshots as PNG).
     Documents: scanner apps and names like "Scan", "Receipt", "Invoice". Photos *of* documents need the special-folders step. */
  const SPECIAL = ["Screenshots", "Documents"];
  const SCREENSHOT_NAME = /screen ?shot|screen[ _-]?recording|screenrecorder|rpreplay|bildschirmfoto|bildschirmaufnahme|captura de (pantalla|tela)|grabaci[oó]n de pantalla|schermafbeelding|schermata|capture d.[ée]cran|sk[äa]rmavbild|skjermbilde|n[äa]ytt[öo]kuva|zrzut ekranu|スクリーンショット/i;
  const DOCUMENT_NAME = /(^|[^a-z])(scan|scans|scanned|scanner|document|documents|doc|receipt|receipts|invoice|factura|recibo|rechnung|beleg|quittung|passport|pasaporte)([^a-z]|$)|camscanner|genius ?scan|adobe ?scan/i;
  function specialOf(f) {
    if (SCREENSHOT_NAME.test(f.name)) return "Screenshots";
    if (DOCUMENT_NAME.test(f.name)) return "Documents";
    if (f.kind === "photo" && /\.png$/i.test(f.name)) return "Screenshots";
    return null;
  }

  /* Which photos to sort: a time range on the date each photo was taken. */
  const RANGE_WORDS = { all: "from all time", year: "from this year", "12m": "from the last 12 months", "3y": "from the last 3 years" };
  const dayStart = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  function rangeBounds() {
    const r = state.range, now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    if (r.kind === "year") return [new Date(y, 0, 1), null];
    if (r.kind === "12m") return [new Date(y - 1, m, d), null];
    if (r.kind === "3y") return [new Date(y - 3, m, d), null];
    if (r.kind === "pick") return [r.from ? dayStart(r.from) : null, r.to ? new Date(dayStart(r.to).getTime() + 864e5 - 1) : null];
    return [null, null];
  }
  const rangeKey = () => `${state.range.kind}|${state.range.from || ""}|${state.range.to || ""}`;
  const allTime = () => state.range.kind === "all" || (state.range.kind === "pick" && !state.range.from && !state.range.to);
  function chosen() {
    if (allTime()) return state.files;
    const [a, b] = rangeBounds();
    return state.files.filter(f => f.date && (!a || f.date >= a) && (!b || f.date <= b));
  }
  function rangeText() {
    const r = state.range;
    if (r.kind !== "pick") return RANGE_WORDS[r.kind];
    const [a, b] = rangeBounds();
    return a && b ? `from ${fmtDate(a)} to ${fmtDate(b)}` : a ? `since ${fmtDate(a)}` : b ? `until ${fmtDate(b)}` : "from all time";
  }
  // The ball shows the chosen photos; rebuilt only when the range changes after everything is read.
  let ballKey = "all||";
  function syncBall() {
    if (state.phase !== "ready" || ballKey === rangeKey()) return;
    Ball.rebuild(chosen()); ballKey = rangeKey();
  }
  // "4 screenshots and 2 documents kept apart"
  function specialNote(files) {
    const n = name => files.filter(f => specialOf(f) === name).length;
    const parts = [[n("Screenshots"), "screenshot", "screenshots"], [n("Documents"), "document", "documents"]].filter(p => p[0]).map(p => count(...p));
    return parts.length ? `${parts.join(" and ")} kept apart` : "";
  }

  // The faint line under a card (and in the final folder list): what's inside it, e.g. "8 months" or "3 countries"
  function subLine(files) {
    if (files.length && files[0].special) return count(new Set(files.map(f => f.target)).size, "year", "years");
    const second = state.layers[1];
    if (!second) return "";
    return count(new Set(files.map(f => f.target)).size, ...LAYER_WORDS[second]);
  }

  // The cards: one per first-layer folder. Years and months newest first; countries biggest first, Unknown country last.
  // More than 12: the rest share one card ("2009–2013", "Earlier months", "14 more countries").
  function planFolders(files) {
    const first = state.layers[0];
    const groups = new Map();
    for (const f of files) {
      f.target = targetOf(f);
      const key = f.target.split("/")[0];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const special = SPECIAL.filter(k => groups.has(k)).map(k => ({ key: k, name: k, files: groups.get(k), special: true }));
    SPECIAL.forEach(k => groups.delete(k));
    const slots = CARD_SLOTS - special.length;
    let folders = [...groups].map(([key, list]) => ({ key, name: key, files: list }));
    if (first === "country") folders.sort((a, b) => (a.key === UNKNOWN_COUNTRY) - (b.key === UNKNOWN_COUNTRY) || b.files.length - a.files.length || a.key.localeCompare(b.key));
    else folders.sort((a, b) => b.key.localeCompare(a.key));
    if (folders.length > slots) {
      const keep = folders.slice(0, slots - 1), rest = folders.slice(slots - 1);
      const name = first === "year" ? `${rest[rest.length - 1].name}–${rest[0].name}`
        : first === "month" ? "Earlier months" : `${fmt(rest.length)} more countries`;
      keep.push({ key: "more", name, files: rest.flatMap(r => r.files) });
      folders = keep;
    }
    folders.push(...special);
    folders.forEach((f, i) => {
      f.color = YEAR_COLORS[i % YEAR_COLORS.length];
      f.files.forEach(file => { file.folderKey = f.key; });
      f.sub = first === "year" || f.key !== "more" ? subLine(f.files) : count(new Set(f.files.map(x => x.target.split("/")[0])).size, ...LAYER_WORDS[first]);
    });
    state.targets = new Set(files.map(file => file.target)).size;
    return folders;
  }

  const relRect = el => {
    const s = $("stage").getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmtDate = d => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const sourceWord = { camera: "camera date", name: "date in the file name", file: "file date" };

  /** Show n in el. Rolling digits like a counter while sorting; the plain number stays in the text for reading and tests. */
  function rollNum(el, n) {
    const s = fmt(n);
    if (reduceMotion) { el.textContent = s; return; }
    let text = el.querySelector(".rn-text"), rn = el.querySelector(".rn");
    if (!text || !rn || rn.dataset.shape !== s.replace(/\d/g, "0")) {
      const old = rn ? [...rn.querySelectorAll(".dg")].map(d => d.style.getPropertyValue("--d")) : [];
      el.innerHTML = `<span class="rn-text"></span><span class="rn" aria-hidden="true">${[...s].map(ch => /\d/.test(ch) ? '<span class="dg"></span>' : `<span>${ch}</span>`).join("")}</span>`;
      text = el.querySelector(".rn-text"); rn = el.querySelector(".rn");
      rn.dataset.shape = s.replace(/\d/g, "0");
      const dgs = [...rn.querySelectorAll(".dg")];
      // Keep the old digits where they line up from the right, so a new digit rolls in instead of everything jumping.
      dgs.forEach((d, i) => { const o = old[old.length - dgs.length + i]; if (o) d.style.setProperty("--d", o); });
      void rn.offsetWidth;
    }
    text.textContent = s;
    const digits = s.replace(/\D/g, "");
    rn.querySelectorAll(".dg").forEach((d, i) => d.style.setProperty("--d", digits[i]));
  }

  function landOn(folder, tile) {
    const c = folder.card;
    const slot = c.slots[Math.min(c.shown, c.slots.length - 1)];
    slot.style.backgroundImage = tile.el.style.backgroundImage;
    // The photo flew before its little picture was ready: load it into the spot now
    if (!slot.style.backgroundImage && tile.rec.kind === "photo") window.GalleryScan.thumb(tile.rec, () => slot.isConnected)
      .then(u => { if (u && slot.isConnected && !slot.style.backgroundImage) slot.style.backgroundImage = `url("${u}")`; });
    slot.classList.remove("filled"); void slot.offsetWidth; slot.classList.add("filled");
    c.shown++; c.landed++;
    (c.recs || (c.recs = new Set())).add(tile.rec);
    c.el.classList.add("hit");
    setTimeout(() => c.el.classList.remove("hit"), 170);
    if (!reduceMotion) c.el.animate([{ transform: "translateY(0)" }, { transform: "translateY(1.5px)", offset: .4 }, { transform: "translateY(0)" }], { duration: 300, easing: "ease-out" });
  }

  function fly(tile, folder, spotlight) {
    return new Promise(resolve => {
      const rec = tile.rec, c = folder.card;
      const cap = $("caption");
      cap.innerHTML = `<span class="mono"></span> → <b></b>`;
      cap.querySelector(".mono").textContent = rec.name;
      cap.querySelector("b").textContent = folder.name;
      cap.querySelector("b").textContent = rec.target.split("/").join(" › ");
      if (spotlight) cap.insertAdjacentText("beforeend", ` · ${sourceWord[rec.dateSource]} ${fmtDate(rec.date)}${hasCountry() ? (rec.place ? " · GPS" : " · no GPS") : ""}`);
      const a = relRect(tile.el);
      tile.el.classList.add("gone");
      Ball.release(tile);
      if (reduceMotion) { landOn(folder, tile); return resolve(); }
      const slot = c.slots[Math.min(c.shown, c.slots.length - 1)], z = relRect(slot), o = relRect($("orb"));
      const w = a.w;
      const fl = document.createElement("div");
      fl.className = "flyer" + (rec.kind === "video" ? " vid" : "");
      fl.style.cssText = `left:${a.x}px;top:${a.y}px;width:${w}px;height:${w}px;background-image:${tile.el.style.backgroundImage}`;
      const lbl = tile.el.querySelector(".lbl");
      if (lbl) fl.appendChild(lbl.cloneNode(true));
      $("stage").appendChild(fl);
      const cx = a.x + w / 2, cy = a.y + w / 2;
      const toX = z.x + z.w / 2 - cx, toY = z.y + z.h / 2 - cy, s = z.w / w;
      const midX = o.x + o.w / 2 - cx, midY = o.y + o.h / 2 - cy;
      const frames = spotlight ? [
        { transform: "translate(0,0) scale(1)", easing: "cubic-bezier(.3,0,.2,1)" },
        { transform: `translate(${midX}px,${midY}px) scale(2.6)`, offset: 0.3 },
        { transform: `translate(${midX}px,${midY}px) scale(2.6)`, offset: 0.62, easing: "cubic-bezier(.5,0,.2,1)" },
        { transform: `translate(${toX}px,${toY}px) scale(${s})` }
      ] : [
        { transform: "translate(0,0) scale(1)" },
        { transform: `translate(${toX * 0.5}px,${toY * 0.5 - 50}px) scale(${(1 + s) / 1.5})`, offset: 0.5 },
        { transform: `translate(${toX}px,${toY}px) scale(${s})` }
      ];
      const anim = fl.animate(frames, { duration: spotlight ? 2000 : 650, easing: spotlight ? "linear" : "cubic-bezier(.45,0,.2,1)", fill: "forwards" });
      anim.onfinish = () => { fl.remove(); landOn(folder, tile); resolve(); };
    });
  }

  /* After the flights: only up to 96 photos fly, so with thousands of photos a small year may get just one.
     Fill each card's empty spots with other photos from that folder, spread across it, fading in quietly. */
  function fillCards(folders, run) {
    const S = window.GalleryScan;
    for (const f of folders) {
      const c = f.card, have = c.recs || new Set();
      const pool = f.files.filter(r => r.kind === "photo" && !have.has(r) && S.canPreview(r.name));
      const empty = c.slots.slice(Math.min(c.shown, c.slots.length)).slice(0, pool.length);   // never the same photo twice
      if (!empty.length) continue;
      const step = pool.length / empty.length;
      empty.forEach((slot, i) => {
        const rec = pool[Math.floor(i * step)];
        if (!rec) return;
        S.thumb(rec, () => slot.isConnected).then(u => {
          if (!u || run !== sortRun || !slot.isConnected || slot.style.backgroundImage) return;
          slot.style.backgroundImage = `url("${u}")`;
          slot.classList.add("fade");
        });
      });
      c.shown = c.slots.length;
    }
  }

  // Every folder should receive at least one flying photo, even a year with 2 photos out of 10,000.
  function ensureEveryFolderFlies(folders) {
    const tilesOf = new Map(folders.map(f => [f.key, []]));
    Ball.tiles.forEach(t => tilesOf.get(t.rec.folderKey).push(t));
    for (const f of folders) {
      if (tilesOf.get(f.key).length) continue;
      const donor = folders.reduce((a, b) => tilesOf.get(b.key).length > tilesOf.get(a.key).length ? b : a);
      if (tilesOf.get(donor.key).length < 2) break;
      const t = tilesOf.get(donor.key).pop();
      Ball.setRec(t, f.files[0]);
      tilesOf.get(f.key).push(t);
    }
  }

  let sortRun = 0;
  async function runSort() {
    if (state.phase === "done") { if (window.GalleryFlow) window.GalleryFlow.next(); else { resetSort(); render(); } return; }
    if (state.phase !== "ready") return;
    const run = ++sortRun;
    state.phase = "sorting";
    setMenu(false);
    syncBall();
    const folders = state.folders = planFolders(chosen());
    buildPlaceholders();
    folders.forEach((f, i) => makeCard(cardSpots[i], f));
    cardSpots.slice(folders.length).forEach(el => el.remove());
    render();

    const byKey = new Map(folders.map(f => [f.key, f]));
    ensureEveryFolderFlies(folders);
    const flights = Ball.tiles.length;
    const total = chosen().length;
    const gap = Math.max(35, Math.min(170, 6500 / Math.max(1, flights)));
    let landed = 0;
    const updateCounts = () => {
      const p = landed / flights;
      for (const f of folders) rollNum(f.card.count, Math.min(f.files.length, Math.max(f.card.landed, Math.round(f.files.length * p))));
      $("progressBar").style.width = (p * 100) + "%";
      $("headline").innerHTML = `Sorting <em class="mark">${fmt(Math.round(total * p))} of ${fmt(total)}</em>`;
    };
    $("progress").hidden = false;
    $("headline").innerHTML = `Sorting <em class="mark">0 of ${fmt(total)}</em>`;
    const pending = [];
    for (let i = 0; i < flights; i++) {
      if (run !== sortRun) return;
      const tile = Ball.takeFront();
      if (!tile) break;
      const spotlight = i < 2 && flights > 6;
      const p = fly(tile, byKey.get(tile.rec.folderKey), spotlight).then(() => { if (run === sortRun) { landed++; updateCounts(); } });
      pending.push(p);
      if (spotlight) await p; else await sleep(reduceMotion ? 10 : gap);
    }
    await Promise.all(pending);
    if (run !== sortRun) return;
    folders.forEach(f => rollNum(f.card.count, f.files.length));
    fillCards(folders, run);
    state.phase = "done";
    // A quiet finish: the circle draws itself, the tick follows, then the folders answer one by one.
    const badge = document.createElement("div");
    badge.className = "done-badge";
    badge.innerHTML = `<svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="49.5" pathLength="1" transform="rotate(-90 50 50)"/></svg><span class="check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-6.5" pathLength="1"/></svg></span><b>All sorted</b><span></span>`;
    badge.lastElementChild.textContent = `${count(total, "item", "items")} in ${count(state.targets, "folder", "folders")}`;
    $("orb").appendChild(badge);
    $("progress").hidden = true;
    render();
    if (!reduceMotion) folders.forEach((f, i) => setTimeout(() => {
      if (run !== sortRun) return;
      f.card.el.classList.add("called");
      setTimeout(() => f.card.el.classList.remove("called"), 260);
    }, 950 + i * 70));
  }

  function resetSort() {
    sortRun++;
    if (window.GalleryFlow) window.GalleryFlow.reset();
    state.phase = "ready";
    state.folders = [];
    document.querySelectorAll(".flyer").forEach(n => n.remove());
    buildPlaceholders();
    Ball.rebuild(chosen()); ballKey = rangeKey();
    $("progress").hidden = true;
  }

  $("sortBtn").addEventListener("click", runSort);

  // Year or Month. Changing it after a sort starts over with the new choice.
  /* How to sort: a first layer and an optional second one. Changing it after a sort starts over. */
  const LAYER_LABEL = { year: "Year", month: "Month", country: "Country" };
  function setLayers(a, b) {
    if (state.phase === "sorting") return;
    if (b && !secondOptions(a).includes(b)) b = "";
    state.layers = b ? [a, b] : [a];
    if (state.phase === "done") resetSort();
    render();
  }
  /* Which photos: a time range. "Pick dates…" shows two date fields. Changing it after a sort starts over. */
  function setRange(kind, from, to) {
    if (state.phase === "sorting") return;
    state.range = { kind, from: from || null, to: to || null };
    if (state.phase === "done") resetSort();
    render();
  }
  $("range").addEventListener("change", e => setRange(e.target.value, $("dateFrom").value, $("dateTo").value));
  $("dateFrom").addEventListener("change", () => setRange("pick", $("dateFrom").value, $("dateTo").value));
  $("dateTo").addEventListener("change", () => setRange("pick", $("dateFrom").value, $("dateTo").value));
  $("layer1").addEventListener("change", e => setLayers(e.target.value, $("layer2").value));
  $("layer2").addEventListener("change", e => setLayers($("layer1").value, e.target.value));
  function renderLayers() {
    const [a, b = ""] = state.layers, l2 = $("layer2");
    $("layer1").value = a;
    const want = ["", ...secondOptions(a)];
    if ([...l2.options].map(o => o.value).join() !== want.join()) {
      l2.innerHTML = "";
      for (const v of want) l2.add(new Option(v ? LAYER_LABEL[v] : "Nothing", v));
    }
    l2.value = b;
    l2.classList.toggle("none", !b);
    $("layer1").disabled = l2.disabled = state.phase === "sorting";
    $("range").value = state.range.kind;
    $("dates").hidden = state.range.kind !== "pick";
    $("range").disabled = $("dateFrom").disabled = $("dateTo").disabled = state.phase === "sorting";
    const today = new Date(), iso = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
    $("dateFrom").max = $("dateTo").value || iso; $("dateTo").min = $("dateFrom").value; $("dateTo").max = iso;
  }


  /* =========================================================
     Render
     ========================================================= */

  let renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  let libsTold = 0;
  function render() {
    const total = state.files.length;
    const photos = state.files.filter(f => f.kind === "photo").length;
    const videos = total - photos;
    const scanning = state.roots.some(r => r.scanning);
    const dated = state.files.filter(f => f.dated).length;

    if (state.phase !== "sorting" && state.phase !== "done") {
      state.phase = !total && !scanning ? "empty" : (scanning || dated < total) ? "reading" : "ready";
    }

    if (state.phase === "ready") syncBall();
    const picked = chosen(), n = picked.length;

    setStat("stTotal", total); setStat("stPhotos", photos); setStat("stVideos", videos);
    setStat("stFolders", state.phase === "done" || state.phase === "sorting" ? state.targets : 0);
    $("sortBtn").disabled = !((state.phase === "ready" && n > 0) || state.phase === "done");
    $("stepLine").textContent = state.phase === "empty" ? "Step 1 of 4 · Add photos" : state.phase === "reading" ? (state.paused && state.roots.some(r => r.scanning) ? "Step 1 of 4 · Paused" : "Step 1 of 4 · Reading photos") : "Step 2 of 4 · Sort";
    $("sortLabel").textContent = state.phase === "done" ? "Sort again" : `Sort by ${layersText()}`;
    renderLayers();
    // Once sorted, the choices become a plain sentence: they were used, so they can't be changed here (Sort again can).
    const sorted = state.phase === "sorting" || state.phase === "done";
    $("sortBy").hidden = sorted; $("sortedBy").hidden = !sorted;
    if (sorted) $("sortedBy").textContent = `Photos ${rangeText()}, sorted by ${state.layers.join(", then ")}.`;

    const H = (a, b) => `${a} <em class="mark">${b}</em>`;
    const pickedVideos = picked.some(f => f.kind === "video");
    const nPhotos = (state.phase === "ready" || state.phase === "done" ? pickedVideos : videos)
      ? `${count(state.phase === "ready" || state.phase === "done" ? n : total, "item", "items")},`
      : `${count(state.phase === "ready" || state.phase === "done" ? n : total, "photo", "photos")},`;
    if (state.phase === "empty") {
      $("headline").innerHTML = H("My photos are", "everywhere.");
      caption("");
      status("idle", "Ready");
    } else if (state.phase === "reading") {
      $("headline").innerHTML = H(nPhotos, "zero folders.");
      if (scanning && state.paused) {
        caption(`Paused · ${fmt(total)} found so far. Resume, or stop here and sort these.`);
        status("idle", "Paused");
      } else {
        caption(scanning ? `Finding photos… ${fmt(total)} so far` : `Reading dates… ${fmt(dated)} of ${fmt(total)}`);
        status("run", scanning ? "Finding photos" : "Reading dates");
      }
    } else if (state.phase === "ready") {
      $("headline").innerHTML = H(nPhotos, "zero folders.");
      const years = new Set(picked.map(f => f.date.getFullYear())).size;
      const fromCamera = picked.filter(f => f.dateSource === "camera").length;
      const lines = [];
      if (!allTime()) lines.push(`${fmt(n)} of ${fmt(total)} ${rangeText()}`);
      if (!n) lines.push("Pick another time");
      else if (hasCountry()) {
        const placed = picked.filter(f => f.place);
        const countries = new Set(placed.map(f => countryOf(f.place))).size;
        lines.push(`${count(countries, "country", "countries")} found`, `${fmt(placed.length)} with a location`);
      } else {
        lines.push(`${count(years, "year", "years")} found`);
        if (allTime()) lines.push(`${fmt(fromCamera)} with the camera's own date`);
      }
      const apart = specialNote(picked);
      if (apart) lines.push(apart);
      caption(lines.join(" · "));
      status("ready", n ? "Ready to sort" : "Nothing to sort");
    } else if (state.phase === "sorting") {
      status("run", "Sorting");
    } else {
      $("headline").innerHTML = H(nPhotos, `${count(state.targets, "tidy folder", "tidy folders")}.`);
      caption("Next: check duplicates, then create the folders on your computer.");
      status("done", "Sorted");
    }

    const roots = state.roots;
    $("sourceLabel").textContent = !roots.length ? "Add photos" : roots.length === 1 ? roots[0].name : `${roots.length} sources`;
    const list = $("sources");
    list.innerHTML = "";
    for (const root of roots) {
      const li = document.createElement("li");
      li.className = "src" + (root.loose ? " loose" : "");
      li.style.setProperty("--sc", root.color);
      li.innerHTML = `<span class="s-ico" aria-hidden="true"></span><span class="s-name"></span><span class="s-n">${root.scanning ? (state.paused ? '<span class="s-tag">paused</span> ' : '<span class="spinner" aria-label="Still counting"></span> ') : root.stopped ? '<span class="s-tag">stopped</span> ' : ""}${fmt(root.photos + root.videos)}</span><button class="s-x" type="button">×</button>`;
      li.querySelector(".s-name").textContent = root.name;
      li.querySelector(".s-name").title = root.name;
      const x = li.querySelector(".s-x");
      x.setAttribute("aria-label", `Remove ${root.name}`);
      x.addEventListener("click", e => { e.stopPropagation(); removeRoot(root.id); });
      list.appendChild(li);
    }
    const libs = state.skipped.filter(s => s.type === "library").length;
    if (libs > libsTold) { libsTold = libs; toast(`Skipped ${count(libs, "photo library", "photo libraries")} (Apple Photos or Lightroom). Export from the app first.`); }
    // While sorting the ball empties on purpose: the "Add photos" circle only shows when nothing is added
    $("orbEmpty").hidden = Ball.tiles.length > 0 || total > 0 || state.phase === "sorting" || state.phase === "done";
    $("demoBtn").hidden = state.phase !== "empty";
    const scanningNow = state.roots.some(r => r.scanning);
    $("scanCtl").hidden = !scanningNow;
    $("pauseBtn").textContent = state.paused ? "Resume" : "Pause";
    // Once sorted, steps 3 and 4 own the headline, caption, status and button.
    if (state.phase === "done" && window.GalleryFlow) window.GalleryFlow.render();
  }

  function setStat(id, n) { const el = $(id); if (id === "stFolders") rollNum(el, n); else el.textContent = fmt(n); el.classList.toggle("zero", n === 0); }
  function caption(text) { $("caption").textContent = text; }
  function status(s, text) { $("status").dataset.s = s; $("statusText").textContent = text; }
  function showNotice(text) { $("browserNotice").textContent = text; $("browserNotice").hidden = false; }

  let toastTimer;
  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
  }

  // Shared with flow.js (steps 3 and 4) and samples.js
  window.GalleryApp = { state, chosen, specialOf, rangeText, allTime, resetSort, render, toast, status, supportsPicker, inFrame, fmt, count, subLine, LAYER_WORDS, UNKNOWN_COUNTRY };

  buildPlaceholders();
  render();
})();
