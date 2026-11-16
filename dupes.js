/* Gallery Organizer: exact duplicates.
   Two files are duplicates when their content is identical, whatever their names.
   Only files of the same size can be identical, so only those are fingerprinted. */
(function () {
  "use strict";

  const WHOLE_FILE_LIMIT = 64 * 1024 * 1024;   // above this (long videos), fingerprint start + end + size
  const SAMPLE = 4 * 1024 * 1024;

  async function sha256(buffer) {
    const h = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function fingerprint(file) {
    if (file.size <= WHOLE_FILE_LIMIT) return sha256(await file.arrayBuffer());
    const head = await file.slice(0, SAMPLE).arrayBuffer();
    const tail = await file.slice(file.size - SAMPLE).arrayBuffer();
    const both = new Uint8Array(SAMPLE * 2 + 16);
    both.set(new Uint8Array(head), 0);
    both.set(new Uint8Array(tail), SAMPLE);
    new DataView(both.buffer).setFloat64(SAMPLE * 2, file.size);
    return "s" + await sha256(both.buffer);
  }

  // Names that look like a copy: "IMG_1234 (1).jpg", "IMG_1234 copy.jpg", "Copia de…", WhatsApp copies.
  const COPY_NAME = /\(\d+\)|\bcopy\b|\bcopia\b|-WA\d+/i;

  /** The copy to keep: an original-looking name, then the bigger file, then the older file, then the shorter name. */
  function bestCopy(recs) {
    return [...recs].sort((a, b) =>
      (COPY_NAME.test(a.name) - COPY_NAME.test(b.name)) ||
      (b.size - a.size) ||
      (a.lastModified - b.lastModified) ||
      (a.name.length - b.name.length) ||
      a.path.localeCompare(b.path)
    )[0];
  }

  /**
   * Find exact duplicates among records (from scan.js).
   * onProgress(done, total) is called while fingerprinting.
   * Returns [{ keep, copies: [rec, …] }].
   */
  async function findDuplicates(records, onProgress) {
    const bySize = new Map();
    for (const r of records) {
      if (!bySize.has(r.size)) bySize.set(r.size, []);
      bySize.get(r.size).push(r);
    }
    const candidates = [...bySize.values()].filter(g => g.length > 1).flat();
    const byPrint = new Map();
    let done = 0, next = 0;
    const add = (r, fp) => {
      const key = fp ? r.size + ":" + fp : "unreadable:" + r.path;
      if (!byPrint.has(key)) byPrint.set(key, []);
      byPrint.get(key).push(r);
    };
    const report = async () => {
      if (onProgress && (done % 16 === 0 || done === candidates.length)) await onProgress(done, candidates.length);
      if (window.GalleryScan) await window.GalleryScan.breathe();
    };
    const pool = window.GalleryPool;
    if (pool && pool.available) {
      // Background workers open and fingerprint small batches, two batches per worker at a time.
      const BATCH = 8;
      const lane = async () => {
        while (next < candidates.length) {
          const batch = candidates.slice(next, next += BATCH);
          let prints;
          try { prints = await pool.run("hash", batch.map(r => ({ file: r.file }))); }
          catch (err) { prints = []; for (const r of batch) prints.push(await fingerprint(r.file).catch(() => null)); }
          for (let i = 0; i < batch.length; i++) { add(batch[i], prints[i]); done++; await report(); }
        }
      };
      await Promise.all(Array.from({ length: pool.size * 2 }, lane));
    } else {
      // On the page: four files at a time; the fingerprint itself is computed by the browser off the page.
      const lane = async () => {
        while (next < candidates.length) {
          const r = candidates[next++];
          add(r, await fingerprint(r.file).catch(() => null));
          done++;
          await report();
        }
      };
      await Promise.all(Array.from({ length: 4 }, lane));
    }
    if (onProgress && !candidates.length) await onProgress(0, 0);
    const byPath = (a, b) => a.path.localeCompare(b.path);
    return [...byPrint.values()].filter(g => g.length > 1).map(g => {
      const keep = bestCopy(g);
      return { keep, copies: g.filter(r => r !== keep).sort(byPath) };
    }).sort((a, b) => byPath(a.keep, b.keep));
  }

  window.GalleryDupes = { fingerprint, bestCopy, findDuplicates, COPY_NAME };
})();
