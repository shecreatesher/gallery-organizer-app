/* Gallery Organizer: "try with sample photos".
   Makes 150 small sample photos across ten years, a few exact copies (to show duplicates)
   12 tiny sample videos, 8 screenshots and 4 scans, then adds them as if picked with "Choose photos".
   Most sample photos carry a GPS position (as phone photos do) in one of six cities, to show Country. */
(() => {
  "use strict";
  /* ---------- Sample photos (with a few real duplicates) ---------- */
  const SCENES = [
    ["#9CC9E8", "#F3E4C6", "#D8C29C"], ["#CFE3E9", "#86A86F", "#3E5B3A"], ["#F6B37A", "#E07A5F", "#3D405B"],
    ["#B8C4D6", "#8A94A6", "#3A3F4B"], ["#DCE7F2", "#F5F7FA", "#B9C6D3"], ["#3B2A22", "#B5703A", "#F0C987"],
    ["#E8D5C4", "#C99B7E", "#5A4636"], ["#BFD7EA", "#E9D27C", "#8C9A4B"], ["#7DB3D9", "#2F6F9F", "#1E3F5A"],
    ["#F3DDE1", "#D6869A", "#5E7D4E"], ["#FFD9A8", "#F29E6D", "#6B4E71"], ["#D9EAD3", "#9CC5A1", "#476A57"]
  ];
  let seed = 21;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pad = n => String(n).padStart(2, "0");
  // Six trips, each a GPS position. Every 4th photo has none (like a scan or a WhatsApp photo).
  const SPOTS = [[40.4168, -3.7038], [41.3874, 2.1686], [38.7223, -9.1393], [48.8566, 2.3522], [35.0116, 135.7681], [40.7128, -74.006]];

  /** Adds a small EXIF block holding only a GPS position to a JPEG (the date stays in the file name). */
  async function withGps(blob, lat, lon) {
    const t = new DataView(new ArrayBuffer(128)), u = new Uint8Array(t.buffer);
    const entry = (at, tag, type, n, v) => { t.setUint16(at, tag, true); t.setUint16(at + 2, type, true); t.setUint32(at + 4, n, true); t.setUint32(at + 8, v, true); };
    const dms = (v, at) => {   // degrees, minutes, seconds as three fractions
      v = Math.abs(v); const d = Math.floor(v), m = Math.floor((v - d) * 60), sec = Math.round(((v - d) * 60 - m) * 6000);
      [[d, 1], [m, 1], [sec, 100]].forEach(([a, b], i) => { t.setUint32(at + i * 8, a, true); t.setUint32(at + i * 8 + 4, b, true); });
    };
    u.set([73, 73], 0); t.setUint16(2, 42, true); t.setUint32(4, 8, true);    // "II", little-endian TIFF
    t.setUint16(8, 1, true); entry(10, 0x8825, 4, 1, 26); t.setUint32(22, 0, true);   // IFD0: pointer to GPS
    t.setUint16(26, 4, true);                                                   // GPS: 4 entries
    entry(28, 1, 2, 2, 0); u.set([lat >= 0 ? 78 : 83, 0], 36);                  // N / S
    entry(40, 2, 5, 3, 80);                                                     // latitude → 80
    entry(52, 3, 2, 2, 0); u.set([lon >= 0 ? 69 : 87, 0], 60);                  // E / W
    entry(64, 4, 5, 3, 104);                                                    // longitude → 104
    t.setUint32(76, 0, true);
    dms(lat, 80); dms(lon, 104);
    const seg = new Uint8Array(10 + u.length);
    seg.set([0xFF, 0xE1, (seg.length - 2) >> 8, (seg.length - 2) & 255, 69, 120, 105, 102, 0, 0]);   // APP1 "Exif\0\0"
    seg.set(u, 10);
    const jpg = new Uint8Array(await blob.arrayBuffer());
    return new Blob([jpg.subarray(0, 2), seg, jpg.subarray(2)], { type: "image/jpeg" });
  }

  function draw(i) {
    const c = document.createElement("canvas"); c.width = c.height = 120;
    const g = c.getContext("2d"), [a, b, d] = SCENES[i % SCENES.length], h = 45 + rnd() * 25;
    const grad = g.createLinearGradient(0, 0, 0, 120);
    grad.addColorStop(0, a); grad.addColorStop(h / 120, b); grad.addColorStop(Math.min(1, (h + 2) / 120), d); grad.addColorStop(1, d);
    g.fillStyle = grad; g.fillRect(0, 0, 120, 120);
    const sun = g.createRadialGradient(20 + rnd() * 80, 15 + rnd() * 30, 0, 50, 30, 26);
    sun.addColorStop(0, "rgba(255,250,235,.9)"); sun.addColorStop(1, "rgba(255,250,235,0)");
    g.fillStyle = sun; g.fillRect(0, 0, 120, 120);
    g.fillStyle = "rgba(30,24,20,.5)"; g.beginPath(); g.ellipse(30 + (i * 7) % 60, 95, 8, 16, 0, 0, 7); g.fill();
    return new Promise(res => c.toBlob(res, "image/jpeg", .8));
  }
  // A phone screenshot (chat bubbles) or a scanned page (lines of text on paper)
  function shot(i) {
    const c = document.createElement("canvas"); c.width = c.height = 120;
    const g = c.getContext("2d"), dark = i % 3 === 2;
    g.fillStyle = dark ? "#1C1C1E" : "#F2F2F7"; g.fillRect(0, 0, 120, 120);
    g.fillStyle = dark ? "#2C2C2E" : "#FFFFFF"; g.fillRect(0, 0, 120, 18);
    for (let r = 0; r < 4; r++) {
      const mine = (r + i) % 2 === 0, w = 40 + rnd() * 30;
      g.fillStyle = mine ? "#2F7CF6" : (dark ? "#3A3A3C" : "#E5E5EA");
      g.beginPath(); g.roundRect(mine ? 112 - w : 8, 26 + r * 23, w, 16, 8); g.fill();
    }
    return new Promise(res => c.toBlob(res, "image/png"));
  }
  function page(i) {
    const c = document.createElement("canvas"); c.width = c.height = 120;
    const g = c.getContext("2d");
    g.fillStyle = "#6E6A64"; g.fillRect(0, 0, 120, 120);
    g.save(); g.translate(60, 60); g.rotate((i % 2 ? 1 : -1) * 0.04); g.fillStyle = "#FBFAF6"; g.fillRect(-42, -54, 84, 108);
    g.fillStyle = "#8D8A84";
    for (let r = 0; r < 9; r++) g.fillRect(-32, -42 + r * 10, r === 0 ? 40 : 50 + rnd() * 14, 3);
    g.restore();
    return new Promise(res => c.toBlob(res, "image/jpeg", .8));
  }
  document.getElementById("demoBtn").addEventListener("click", async () => {
    const btn = document.getElementById("demoBtn");
    btn.disabled = true;
    btn.textContent = "Making sample photos…";
    const files = [];
    for (let i = 0; i < 150; i++) {
      const y = 2016 + Math.floor(rnd() * 10), m = 1 + Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 28);
      let blob = await draw(i);
      const name = `IMG_${y}${pad(m)}${pad(d)}_${1000 + i}`;
      if (i % 4 !== 3) { const [lat, lon] = SPOTS[(y * 7 + m) % SPOTS.length]; blob = await withGps(blob, lat + rnd() * 0.02, lon + rnd() * 0.02); }
      files.push(new File([blob], name + ".jpg", { type: "image/jpeg", lastModified: Date.now() }));
      // Every 11th photo also exists as a copy: "(1)" from a second backup, or a WhatsApp copy.
      if (i % 11 === 3) files.push(new File([blob], `${name} (1).jpg`, { type: "image/jpeg", lastModified: Date.now() }));
      if (i % 23 === 5) files.push(new File([blob], `IMG-${y}${pad(m)}${pad(d)}-WA00${pad(i % 99)}.jpg`, { type: "image/jpeg", lastModified: Date.now() }));
    }
    for (let i = 0; i < 12; i++) {
      const y = 2016 + Math.floor(rnd() * 10), m = 1 + Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 28);
      files.push(new File([`sample video ${i}`], `VID_${y}${pad(m)}${pad(d)}_${2000 + i}.mp4`, { type: "video/mp4", lastModified: Date.now() }));
    }
    // A few screenshots and scans: these go into their own Screenshots and Documents folders.
    for (let i = 0; i < 8; i++) {
      const y = 2019 + Math.floor(rnd() * 7), m = 1 + Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 28);
      files.push(new File([await shot(i)], `Screenshot ${y}-${pad(m)}-${pad(d)} at ${pad(9 + i)}.${pad((i * 7) % 60)}.png`, { type: "image/png", lastModified: Date.now() }));
    }
    for (let i = 0; i < 4; i++) {
      const y = 2019 + Math.floor(rnd() * 7), m = 1 + Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 28);
      files.push(new File([await page(i)], `Scan ${y}-${pad(m)}-${pad(d)}.jpg`, { type: "image/jpeg", lastModified: Date.now() }));
    }
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const input = document.getElementById("photoPicker");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
    btn.hidden = true;
  });
})();
