/* Gallery Organizer: steps 3 and 4, on the same screen.
   3 · Duplicates: exact copies fly out of their year folders into a "Duplicates · Not copied" card.
   4 · Create: pick where the new library goes, copy every photo into its year folder, write an undo log.
   Copies only. Original photos are never moved, renamed or deleted. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const A = () => window.GalleryApp;
  const D = () => window.GalleryDupes;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const size = b => b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(0.1, b / 1e6).toFixed(1) + " MB";
  const LIBRARY_NAME = "Gallery Organizer";
  const LOG_NAME = "photo-sorter-log.json";

  const flow = {
    stage: "none",        // none | checking | checked | choosing | copying | created
    groups: [],           // [{ keep, copies }]
    dest: null,           // FileSystemDirectoryHandle chosen by the user
    libName: LIBRARY_NAME,
    dryRun: false,
    result: null          // { copied, failed: [], logWritten }
  };
  window.GalleryFlowState = flow;

  /* ---------- helpers ---------- */
  const state = () => A().state;
  // In each duplicate group every photo is either kept (copied) or skipped. The best copy starts kept;
  // people can keep more, or none at all (then that photo isn't in the new library; the original stays put).
  const kept = r => !r.skip;
  const toCopy = () => A().chosen().filter(kept);   // only the photos in the chosen time range
  const folderOf = r => state().folders.find(f => f.key === r.folderKey);
  const copiesSetAside = () => flow.groups.flatMap(g => g.members).filter(r => r.skip);
  const firstKept = g => g.members.find(kept);
  // Small pictures (see GalleryScan.thumb). thumb() gives what's ready now; showThumb() fills it in when ready.
  const thumb = rec => {
    if (!window.GalleryScan.canThumb(rec)) return "linear-gradient(160deg,#8d8d8d,#3c3c3c)";
    if (rec.thumbUrl) return `url("${rec.thumbUrl}")`;
    window.GalleryScan.thumb(rec);
    return "";
  };
  const showThumb = (el, rec) => {
    el.style.backgroundImage = thumb(rec);
    if (!rec.thumbUrl) window.GalleryScan.thumb(rec, () => el.isConnected).then(u => { if (u) el.style.backgroundImage = `url("${u}")`; });
  };
  const step = t => { $("stepLine").textContent = t; };
  const button = (label, enabled = true) => { $("sortLabel").textContent = label; $("sortBtn").disabled = !enabled; };
  const headline = (a, b) => { $("headline").innerHTML = ""; $("headline").append(a + " "); const em = document.createElement("em"); em.className = "mark"; em.textContent = b; $("headline").append(em); };
  const caption = t => { $("caption").textContent = t; };
  function panel(show) {
    $("cpanel").hidden = !show;
    $("orb").hidden = show;
  }
  function updateCounts() {
    for (const f of state().folders) f.card.count.textContent = A().fmt(f.files.filter(kept).length);
    if (flow.dupCard) flow.dupCard.querySelector(".f-count").textContent = A().fmt(copiesSetAside().length);
  }

  /* ---------- public: called by app.js ---------- */
  function reset() {
    flow.stage = "none";
    flow.groups = [];
    flow.dest = null;
    flow.dryRun = false;
    flow.result = null;
    if (flow.dupCard) { flow.dupCard.remove(); flow.dupCard = null; }
    state().files.forEach(f => { delete f.dupOf; delete f.skip; delete f.dupGroup; });
    $("cpanel").innerHTML = "";
    panel(false);
    $("sheet").hidden = true;
    $("againBtn").hidden = true;
    $("reviewBtn").hidden = true;
    document.querySelectorAll(".fcard .cbar").forEach(n => n.remove());
    document.querySelectorAll(".fcard.copied, .fcard.copying").forEach(n => n.classList.remove("copied", "copying"));
  }

  function next() {
    if (flow.stage === "none") checkDuplicates();
    else if (flow.stage === "checked") chooseDestination();
    else if (flow.stage === "choosing") createLibrary();
    else if (flow.stage === "created") { A().resetSort(); A().render(); }
  }

  // Runs at the end of app.js render() while phase is "done"
  function render() {
    const s = flow.stage, n = copiesSetAside().length, fmt = A().fmt, count = A().count;
    $("againBtn").hidden = !(s === "none" || s === "checked");
    // Reviewing is optional: a second button beside the main one, only when there's something to review.
    $("reviewBtn").hidden = !(s === "checked" && flow.groups.length);
    if (s === "none") {
      step("Step 3 of 4 · Duplicates");
      button("Check duplicates");
      caption("");
    } else if (s === "checking") {
      step("Step 3 of 4 · Duplicates");
      button("Checking…", false);
      A().status("run", "Checking");
    } else if (s === "checked") {
      step("Step 3 of 4 · Duplicates · done");
      button("Create folders");
      A().status("ready", "Ready to create");
      const extra = flow.groups.reduce((t, g) => t + Math.max(0, g.members.filter(kept).length - 1), 0);
      if (n) headline(`${count(flow.groups.length, "photo", "photos")} with copies,`, "keeping what's selected.");
      else if (flow.groups.length) headline("Keeping", "every copy.");
      else headline("No duplicates.", "Every photo is unique.");
      caption(n ? `${size(copiesSetAside().reduce((t, c) => t + c.size, 0))} you won't copy twice${extra ? ` · keeping ${count(extra, "extra copy", "extra copies")}` : ""}`
        : flow.groups.length ? `${count(extra, "extra copy", "extra copies")} will be copied too.` : "Nothing left out.");
    } else if (s === "choosing") {
      step("Step 4 of 4 · Create");
      button(flow.dryRun ? "Run a preview" : "Create library", flow.dryRun || !!flow.dest);
      A().status("ready", "Ready to create");
      headline("Where should the", "new library go?");
      caption("Your original photos are not moved or changed.");
    } else if (s === "copying") {
      step("Step 4 of 4 · Create");
      button("Copying…", false);
      A().status("run", flow.dryRun ? "Previewing" : "Copying");
    } else if (s === "created") {
      step("Step 4 of 4 · Create · done");
      button("Start again");
      A().status("done", flow.dryRun ? "Preview done" : "Created");
      headline(`${count(flow.result.copied, "item", "items")},`, `${count(state().targets, "folder", "folders")} ${flow.dryRun ? "planned." : "created."}`);
      caption(flow.dryRun ? "Preview only: nothing was written to your disk." : "Done. Check the new folder, then delete the old ones yourself when you're happy.");
    }
  }

  $("againBtn").addEventListener("click", () => { A().resetSort(); A().render(); });
  $("reviewBtn").addEventListener("click", () => openSheet());

  /* ---------- flights between cards ---------- */
  const rel = el => {
    const s = $("stage").getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
  };
  function fly(fromEl, toEl, bg) {
    if (reduceMotion) return Promise.resolve();
    const a = rel(fromEl), z = rel(toEl), w = Math.min(a.w, a.h, 44);
    const fl = document.createElement("div");
    fl.className = "flyer";
    fl.style.cssText = `left:${a.x + a.w / 2 - w / 2}px;top:${a.y + a.h / 2 - w / 2}px;width:${w}px;height:${w}px;background-image:${bg}`;
    $("stage").appendChild(fl);
    const dx = z.x + z.w / 2 - (a.x + a.w / 2), dy = z.y + z.h / 2 - (a.y + a.h / 2);
    return fl.animate([
      { transform: "translate(0,0) scale(1)" },
      { transform: `translate(${dx * .5}px,${dy * .5 - 40}px) scale(1.15)`, offset: .5 },
      { transform: `translate(${dx}px,${dy}px) scale(${Math.max(.3, z.w / w)})` }
    ], { duration: 600, easing: "cubic-bezier(.45,0,.2,1)", fill: "forwards" }).finished.then(() => fl.remove());
  }

  /* ---------- step 3: duplicates ---------- */
  async function checkDuplicates() {
    flow.stage = "checking";
    render();
    headline("Looking for", "duplicates");
    $("progress").hidden = false;
    const fmt = A().fmt;
    flow.groups = await D().findDuplicates(A().chosen(), async (done, total) => {
      caption(total ? `Comparing photos… ${fmt(done)} of ${fmt(total)} that share a size` : "Comparing photos…");
      $("progressBar").style.width = (total ? done / total * 100 : 100) + "%";
      await sleep(0);
    });
    if (flow.stage !== "checking") return;   // reset while checking
    flow.groups.forEach(g => {
      g.members = [g.keep, ...g.copies];
      g.members.forEach(r => { r.dupGroup = g; r.skip = r !== g.keep; });
      g.copies.forEach(c => { c.dupOf = g.keep; });
    });
    const copies = flow.groups.flatMap(g => g.copies);

    if (copies.length) {
      const card = flow.dupCard = document.createElement("div");
      card.className = "fcard live dupcard";
      card.setAttribute("role", "button"); card.tabIndex = 0;
      card.setAttribute("aria-label", "Review duplicates");
      const review = () => { if (flow.stage === "checked") openSheet(); };
      card.addEventListener("click", review);
      card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); review(); } });
      card.innerHTML = `<div class="f-head"><span class="f-name">Duplicates</span><span class="f-count">0</span></div><div class="slots">${'<i class="slot"></i>'.repeat(6)}</div><p class="f-note">Not copied</p>`;
      $("colRight").appendChild(card);
      const slots = [...card.querySelectorAll(".slot")], countEl = card.querySelector(".f-count");
      // Load the pictures first, so no flying copy is ever blank
      await Promise.race([Promise.all(copies.slice(0, 40).map(c => window.GalleryScan.thumb(c))), sleep(2000)]);   // don't wait long for slow videos
      let n = 0;
      const flights = [];
      const shown = copies.slice(0, 40);      // animate up to 40, count all
      const left = new Map(state().folders.map(f => [f, f.files.length]));
      for (const c of shown) {
        const folder = folderOf(c), target = slots[Math.min(n, slots.length - 1)];
        $("caption").textContent = `${c.name} = ${c.dupOf.name}`;
        flights.push(fly(folder.card.el.querySelector(".slots"), target, thumb(c)).then(() => {
          target.style.backgroundImage = thumb(c);
          target.classList.remove("filled"); void target.offsetWidth; target.classList.add("filled");
          countEl.textContent = fmt(++n);
          left.set(folder, left.get(folder) - 1);
          folder.card.count.textContent = fmt(left.get(folder));
          card.classList.add("hit"); setTimeout(() => card.classList.remove("hit"), 160);
        }));
        await sleep(reduceMotion ? 5 : 170);
      }
      await Promise.all(flights);
    }
    $("progress").hidden = true;
    flow.stage = "checked";
    // The Duplicates card pops once, so it's clear you can open it and look
    if (flow.dupCard && !reduceMotion) flow.dupCard.animate([{ transform: "scale(1)" }, { transform: "scale(1.05)", offset: .4 }, { transform: "scale(1)" }], { duration: 450, easing: "ease-out" });
    updateCounts();
    showDuplicatePanel();
    render();
  }

  function showDuplicatePanel() {
    const n = copiesSetAside().length, count = A().count;
    const keptExtra = flow.groups.reduce((t, g) => t + Math.max(0, g.members.filter(kept).length - 1), 0);
    const noneKept = flow.groups.filter(g => !g.members.some(kept)).length;
    const p = $("cpanel");
    p.innerHTML = "";
    const head = document.createElement("div");
    head.className = "cp-head";
    head.innerHTML = `<b></b><span></span>`;
    head.querySelector("b").textContent = flow.groups.length ? `${count(flow.groups.length, "photo", "photos")} with copies` : "No duplicates";
    head.querySelector("span").textContent = !flow.groups.length ? "Every photo appears only once."
      : noneKept || keptExtra ? [keptExtra && `You're keeping ${count(keptExtra, "extra copy", "extra copies")}.`, noneKept && `${count(noneKept, "photo", "photos")} left out completely.`, "The rest won't be copied."].filter(Boolean).join(" ")
      : `The best copy of each is selected (the original name, then the biggest file). Only selected copies go into your library, so ${count(n, "extra copy isn't", "extra copies aren't")} copied.`;
    p.appendChild(head);
    if (flow.groups.length) {
      const ul = document.createElement("ul");
      ul.className = "dups";
      flow.groups.slice(0, 4).forEach(g => {
        const li = document.createElement("li");
        g.members.slice(0, 4).forEach(r => {
          const e = document.createElement("span");
          e.className = kept(r) ? "k" : "c";
          e.title = kept(r) ? "Kept" : "Not copied";
          showThumb(e, r);
          li.appendChild(e);
        });
        const dn = document.createElement("span"); dn.className = "dn"; dn.textContent = (firstKept(g) || g.keep).name; li.appendChild(dn);
        ul.appendChild(li);
      });
      p.appendChild(ul);
      if (flow.groups.length > 4) { const m = document.createElement("p"); m.className = "more"; m.textContent = `and ${count(flow.groups.length - 4, "more group", "more groups")}`; p.appendChild(m); }
    }
    panel(true);
  }

  /* Review sheet: the best copy of each photo starts selected. Tap any photo to select or unselect it; none is fine too. */
  function openSheet() {
    const grid = $("sheetGrid"), count = A().count;
    grid.innerHTML = "";
    flow.groups.forEach(g => {
      const row = document.createElement("div");
      row.className = "sg-group";
      row.innerHTML = `<div class="sg-head"><span class="sg-title"></span></div><div class="sg-row"></div>`;
      const strip = row.querySelector(".sg-row");
      const buttons = g.members.map(r => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "member";
        b.innerHTML = `<div class="im"><span class="tick" aria-hidden="true"></span></div>${r === g.keep ? '<span class="best">Best</span>' : ""}<span class="mono"></span>`;
        showThumb(b.querySelector(".im"), r);
        b.querySelector(".mono").textContent = r.path;
        b.addEventListener("click", () => {
          r.skip = !r.skip;
          paint();
        });
        strip.appendChild(b);
        return { r, b };
      });
      const paint = () => {
        for (const { r, b } of buttons) {
          b.classList.toggle("kept", kept(r));
          b.setAttribute("aria-pressed", String(kept(r)));
          b.setAttribute("aria-label", `${kept(r) ? "Selected" : "Not selected"}: ${r.path}${r === g.keep ? " (best)" : ""}`);
        }
        const k = g.members.filter(kept).length;
        row.querySelector(".sg-title").textContent = `${count(g.members.length, "identical photo", "identical photos")} · ${k ? "keeping " + k : "keeping none"}`;
      };
      paint();
      grid.appendChild(row);
    });
    $("sheet").hidden = false;
    $("sheetDone").focus();
  }
  function closeSheet() {
    $("sheet").hidden = true;
    updateCounts();
    showDuplicatePanel();
    render();
  }
  $("sheetDone").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", e => { if (e.target === $("sheet")) closeSheet(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

  /* ---------- step 4: create ---------- */
  function chooseDestination() {
    flow.stage = "choosing";
    flow.dryRun = !A().supportsPicker;
    showDestinationPanel();
    render();
  }

  // "one folder per year inside" · "a folder per country and a folder per year inside each"
  function layoutText() {
    const [a, b] = state().layers;
    return b ? `a folder per ${a} and a folder per ${b} inside each` : `one folder per ${a} inside`;
  }

  function showDestinationPanel() {
    const files = toCopy(), photos = files.filter(f => f.kind === "photo").length, fmt = A().fmt;
    const where = flow.dest ? `${flow.dest.name}/` : "";
    $("cpanel").innerHTML = `
      <div class="cp-head"><b>New library</b><span>A new folder named “${LIBRARY_NAME}”, with ${layoutText()}.</span></div>
      ${flow.dryRun
        ? `<p class="dest dest-note">${A().inFrame ? `This version can't write files, so this runs as a preview. To really create the folders, open <span class="mono">index.html</span> in Chrome or Edge on your computer.` : "Designed for computers. Open it on a laptop or desktop to create your library."}</p>`
        : `<button class="dest" type="button" id="destBtn"><span class="mono"></span><b></b><span class="chg"></span></button>`}
      <dl class="sum">
        <div><dt>Folders</dt><dd>${fmt(state().targets)}</dd></div>
        <div><dt>Photos</dt><dd>${fmt(photos)}</dd></div>
        <div><dt>Videos</dt><dd>${fmt(files.length - photos)}</dd></div>
        <div><dt>Size</dt><dd>${size(files.reduce((t, f) => t + f.size, 0))}</dd></div>
      </dl>
      <p class="fine">Duplicates are not copied. A log of every copy is saved in the new folder.</p>`;
    const btn = $("destBtn");
    if (btn) {
      btn.querySelector(".mono").textContent = flow.dest ? where : "Choose where to put it";
      btn.querySelector("b").textContent = flow.dest ? LIBRARY_NAME : "";
      btn.querySelector(".chg").textContent = flow.dest ? "Change" : "Choose…";
      btn.addEventListener("click", pickDestination);
    }
    panel(true);
  }

  async function pickDestination() {
    try {
      flow.dest = await window.showDirectoryPicker({ id: "gallery-destination", mode: "readwrite", startIn: "pictures" });
    } catch (err) {
      if (err && err.name !== "AbortError") A().toast("Couldn't use that folder. Try another one.");
      return;
    }
    // Writing the library inside one of the source folders would make it part of the next scan.
    for (const root of state().roots) {
      const rel = root.handle ? await window.GalleryScan.relation(root.handle, flow.dest) : null;
      if (rel === "same" || rel === "inside") {
        A().toast(`That's inside ${root.name}, one of your sources. Pick a folder outside it.`);
        flow.dest = null;
        break;
      }
    }
    showDestinationPanel();
    render();
  }

  // "IMG_1.jpg" → "IMG_1 (2).jpg"
  function uniqueName(name, taken) {
    if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
    const dot = name.lastIndexOf("."), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; ; i++) {
      const candidate = `${base} (${i})${ext}`;
      if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; }
    }
  }

  async function existingNames(dir) {
    const names = new Set();
    for await (const entry of dir.values()) names.add(entry.name.toLowerCase());
    return names;
  }

  async function freeLibraryName(dest) {
    const taken = await existingNames(dest);
    let name = LIBRARY_NAME;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${LIBRARY_NAME} ${i}`;
    return name;
  }

  async function createLibrary() {
    if (!flow.dryRun && !flow.dest) return;
    flow.stage = "copying";
    render();
    const files = toCopy(), total = files.length, fmt = A().fmt;
    let library = null;
    if (!flow.dryRun) {
      try {
        if ((await flow.dest.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("permission");
        flow.libName = await freeLibraryName(flow.dest);
        library = await flow.dest.getDirectoryHandle(flow.libName, { create: true });
      } catch (err) {
        A().toast("Couldn't create the folder there. Choose another place.");
        flow.stage = "choosing"; flow.dest = null; showDestinationPanel(); render();
        return;
      }
    }
    const where = flow.dryRun ? LIBRARY_NAME : `${flow.dest.name}/${flow.libName}`;
    $("cpanel").innerHTML = `
      <div class="cp-head"><b id="cpN">0 of ${fmt(total)}</b><span class="mono"></span></div>
      <div class="progress big"><i id="cpBar"></i></div>
      <p class="fine">Your original photos stay where they are.</p>`;
    $("cpanel").querySelector(".mono").textContent = `${flow.dryRun ? "Previewing" : "Copying to"} ${where}`;
    panel(true);

    const log = { app: "Gallery Organizer", created: new Date().toISOString(), library: where, sortedBy: state().layers.join(" › "), copied: [], notCopiedDuplicates: [], failed: [] };
    // One handle and one set of taken names per folder path ("2024" or "2024/03 March"), created on first use
    const dirs = new Map();
    async function dirFor(target) {
      if (!dirs.has(target)) {
        dirs.set(target, (async () => {
          let dir = library;
          for (const part of target.split("/")) dir = await dir.getDirectoryHandle(part, { create: true });
          return { dir, taken: await existingNames(dir) };
        })());
      }
      return dirs.get(target);
    }
    const dryTaken = new Map();
    let done = 0, lastPaint = 0;
    const paint = (rec, folder) => {
      $("cpBar").style.width = (done / total * 100) + "%";
      $("cpN").textContent = `${fmt(done)} of ${fmt(total)}`;
      headline("Copying", `${fmt(done)} of ${fmt(total)}`);
      $("caption").textContent = `${rec.name} → ${rec.target.split("/").join(" › ")}`;
    };
    const perFile = Math.max(6, Math.min(50, 5000 / Math.max(1, total)));

    for (const folder of state().folders) {
      const list = folder.files.filter(kept);
      const bar = document.createElement("div");
      bar.className = "cbar"; bar.innerHTML = "<i></i>";
      folder.card.el.appendChild(bar);
      folder.card.el.classList.add("copying");
      for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        if (library) {
          try {
            const { dir, taken } = await dirFor(rec.target);
            const name = uniqueName(rec.name, taken);
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(rec.file);
            await w.close();
            log.copied.push({ from: rec.path, to: `${rec.target}/${name}`, size: rec.size, taken: rec.date.toISOString(), dateFrom: rec.dateSource, ...(rec.place ? { place: rec.place } : {}) });
          } catch (err) {
            dirs.delete(rec.target);
            log.failed.push({ from: rec.path, reason: String(err && err.message || err) });
          }
        } else {
          if (!dryTaken.has(rec.target)) dryTaken.set(rec.target, new Set());
          log.copied.push({ from: rec.path, to: `${rec.target}/${uniqueName(rec.name, dryTaken.get(rec.target))}` });
          await sleep(reduceMotion ? 0 : perFile);
        }
        done++;
        bar.firstChild.style.width = ((i + 1) / list.length * 100) + "%";
        const now = performance.now();
        if (now - lastPaint > 60 || i === list.length - 1) { lastPaint = now; paint(rec, folder); await sleep(0); }
        if (flow.stage !== "copying") return;
      }
      folder.card.el.classList.remove("copying");
      folder.card.el.classList.add("copied");
    }
    log.notCopiedDuplicates = copiesSetAside().map(c => ({ from: c.path, sameAs: firstKept(c.dupGroup) ? firstKept(c.dupGroup).path : null }));

    let logWritten = false;
    if (library) {
      try {
        const fh = await library.getFileHandle(LOG_NAME, { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(log, null, 2));
        await w.close();
        logWritten = true;
      } catch (err) { /* reported below */ }
    }
    flow.result = { copied: log.copied.length, failed: log.failed, logWritten, where };
    flow.stage = "created";
    showCreatedPanel();
    render();
  }

  function showCreatedPanel() {
    const fmt = A().fmt, count = A().count, r = flow.result, n = copiesSetAside().length;
    const p = $("cpanel");
    p.innerHTML = `<div class="cp-head"><span class="check" aria-hidden="true"></span><b></b><span class="mono"></span></div><ul class="tree"></ul>`;
    p.querySelector("b").textContent = flow.dryRun ? "Preview finished" : "Your library is ready";
    p.querySelector(".mono").textContent = r.where;
    const ul = p.querySelector(".tree");
    // One row per first-layer folder, with what's inside it: "8 months", "3 countries"
    const years = new Map();   // first-layer folders: years, months or countries
    for (const rec of toCopy()) {
      const y = rec.target.split("/")[0];
      if (!years.has(y)) years.set(y, []);
      years.get(y).push(rec);
    }
    const byCountry = state().layers[0] === "country", unknown = A().UNKNOWN_COUNTRY;
    const apart = v => (v[1][0].special ? 1 : 0);   // Screenshots and Documents last
    const order = byCountry
      ? (a, b) => apart(a) - apart(b) || (a[0] === unknown) - (b[0] === unknown) || b[1].length - a[1].length || a[0].localeCompare(b[0])
      : (a, b) => apart(a) - apart(b) || b[0].localeCompare(a[0]);
    for (const [y, v] of [...years].sort(order)) {
      const li = document.createElement("li");
      li.innerHTML = "<span></span><span></span>";
      li.firstChild.textContent = y + "/";
      const sub = A().subLine(v);
      li.lastChild.textContent = sub ? `${sub} · ${fmt(v.length)}` : fmt(v.length);
      ul.appendChild(li);
    }
    if (n) { const li = document.createElement("li"); li.className = "skip"; li.innerHTML = `<span>Duplicates</span><span>${fmt(n)} not copied</span>`; ul.appendChild(li); }
    const notes = [];
    if (r.failed.length) notes.push(`${count(r.failed.length, "file", "files")} couldn't be copied. They're listed in the log.`);
    if (r.logWritten) notes.push(`${LOG_NAME} saved in the new folder: every file's old and new place.`);
    if (flow.dryRun) notes.push("Preview only: nothing was written to your disk.");
    else notes.push("Copied files get today's date as their file date; the date the photo was taken stays inside each photo.");
    for (const t of notes) { const e = document.createElement("p"); e.className = "fine"; e.textContent = t; p.appendChild(e); }
    panel(true);
  }

  window.GalleryFlow = { next, reset, render };
})();
