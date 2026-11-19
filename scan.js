/* Gallery Organizer: folder scanning.
   Walks a folder recursively and reports every photo and video it finds.
   Works with File System Access API handles (Chrome, Edge) and, as a
   read-only fallback, with a FileList from <input webkitdirectory>. */
(function () {
  "use strict";

  const PHOTO_EXT = new Set([
    "jpg", "jpeg", "jpe", "png", "heic", "heif", "webp", "gif", "avif", "bmp", "tif", "tiff",
    "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "srw", "pef"
  ]);
  const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "avi", "mkv", "3gp", "mts", "m2ts", "wmv", "webm"]);
  // Formats Chrome can show as a thumbnail directly.
  const PREVIEW_EXT = new Set(["jpg", "jpeg", "jpe", "png", "webp", "gif", "avif", "bmp"]);

  // Folders that never hold your own photos.
  const SKIP_DIR = /^(\.|@eaDir$|\$RECYCLE\.BIN$|System Volume Information$|node_modules$|__MACOSX$)/i;
  // Apple Photos and Lightroom libraries hold originals plus many generated copies.
  const LIBRARY_DIR = /\.(photoslibrary|lrdata|lrlibrary)$/i;

  // Long loops pause for a moment every ~30 ms so the page keeps responding.
  // A MessageChannel is used instead of setTimeout, which browsers slow down in background tabs.
  const channel = new MessageChannel(), wakers = [];
  channel.port1.onmessage = () => { const w = wakers.shift(); if (w) w(); };
  let lastBreath = performance.now();
  async function breathe() {
    if (performance.now() - lastBreath < 30) return;
    await new Promise(r => { wakers.push(r); channel.port2.postMessage(0); });
    lastBreath = performance.now();
  }

  function extOf(name) {
    const i = name.lastIndexOf(".");
    return i < 0 ? "" : name.slice(i + 1).toLowerCase();
  }

  function kindOf(name) {
    if (name.startsWith(".")) return null;
    const ext = extOf(name);
    if (PHOTO_EXT.has(ext)) return "photo";
    if (VIDEO_EXT.has(ext)) return "video";
    return null;
  }

  function canPreview(name) {
    return PREVIEW_EXT.has(extOf(name));
  }

  /**
   * Scan a directory handle depth-first.
   * onFile(record) is called for each photo or video.
   * onSkip({type, path}) is called for skipped libraries and unreadable files.
   * signal stops the scan (keeping what was found); waitIfPaused() returns a promise while paused.
   */
  async function scanDirectory(dirHandle, { rootId, onFile, onSkip, signal, waitIfPaused } = {}) {
    const stack = [{ handle: dirHandle, path: dirHandle.name }];
    while (stack.length) {
      if (signal && signal.aborted) return;
      const { handle, path } = stack.pop();
      try {
        for await (const entry of handle.values()) {
          if (signal && signal.aborted) return;
          await breathe();
          if (waitIfPaused) { await waitIfPaused(); if (signal && signal.aborted) return; }
          const entryPath = path + "/" + entry.name;
          if (entry.kind === "directory") {
            if (SKIP_DIR.test(entry.name)) continue;
            if (LIBRARY_DIR.test(entry.name)) {
              onSkip && onSkip({ type: "library", path: entryPath });
              continue;
            }
            stack.push({ handle: entry, path: entryPath });
            continue;
          }
          const kind = kindOf(entry.name);
          if (!kind) continue;
          let file;
          try {
            file = await entry.getFile();
          } catch (err) {
            onSkip && onSkip({ type: "unreadable", path: entryPath });
            continue;
          }
          onFile(makeRecord(rootId, entry, file, entryPath, kind));
        }
      } catch (err) {
        onSkip && onSkip({ type: "unreadable", path });
      }
    }
  }

  /** Record for a single picked or dropped file, or null if it isn't a photo or video. */
  function fileRecord(rootId, file, path) {
    const kind = kindOf(file.name);
    return kind ? makeRecord(rootId, null, file, path || file.name, kind) : null;
  }

  /**
   * Scan a dropped folder given as a FileSystemEntry (webkitGetAsEntry).
   * Works everywhere drag and drop works, including embedded pages.
   */
  async function scanEntry(dirEntry, { rootId, onFile, onSkip, signal, waitIfPaused } = {}) {
    const readAll = reader => new Promise(resolve => {
      const out = [];
      const next = () => reader.readEntries(batch => {
        if (!batch.length) return resolve(out);
        out.push(...batch); next();
      }, () => resolve(out));
      next();
    });
    const stack = [{ entry: dirEntry, path: dirEntry.name }];
    while (stack.length) {
      if (signal && signal.aborted) return;
      const { entry, path } = stack.pop();
      for (const child of await readAll(entry.createReader())) {
        await breathe();
        if (waitIfPaused) await waitIfPaused();
        if (signal && signal.aborted) return;
        const childPath = path + "/" + child.name;
        if (child.isDirectory) {
          if (SKIP_DIR.test(child.name)) continue;
          if (LIBRARY_DIR.test(child.name)) { onSkip && onSkip({ type: "library", path: childPath }); continue; }
          stack.push({ entry: child, path: childPath });
          continue;
        }
        const kind = kindOf(child.name);
        if (!kind) continue;
        try {
          const file = await new Promise((res, rej) => child.file(res, rej));
          onFile(makeRecord(rootId, null, file, childPath, kind));
        } catch (err) {
          onSkip && onSkip({ type: "unreadable", path: childPath });
        }
      }
    }
  }

  /** Upload-style folder picker (<input webkitdirectory>): build records from its file list. */
  async function fromFileList(fileList, rootId) {
    const records = [];
    let rootName = "";
    for (const file of fileList) {
      await breathe();
      const path = file.webkitRelativePath || file.name;
      const parts = path.split("/");
      rootName = rootName || parts[0];
      if (parts.slice(0, -1).some(p => SKIP_DIR.test(p) || LIBRARY_DIR.test(p))) continue;
      const kind = kindOf(file.name);
      if (!kind) continue;
      records.push(makeRecord(rootId, null, file, path, kind));
    }
    return { rootName, records };
  }

  function makeRecord(rootId, handle, file, path, kind) {
    return {
      rootId,
      handle,            // FileSystemFileHandle, or null in read-only mode
      file,              // File (lazy, no bytes read yet)
      name: file.name,
      path,              // "Root folder/sub/IMG_0001.jpg"
      size: file.size,
      lastModified: file.lastModified,
      kind,              // "photo" | "video"
      ext: extOf(file.name)
    };
  }

  /**
   * Compare a new folder with one already added.
   * Returns "same", "inside" (new is inside existing), "contains" (new contains existing) or null.
   */
  async function relation(existing, added) {
    if (!existing || !added) return null;
    try {
      if (await existing.isSameEntry(added)) return "same";
      if (await existing.resolve(added)) return "inside";
      if (await added.resolve(existing)) return "contains";
    } catch (err) {
      /* resolve() is unsupported on some handles: treat as unrelated */
    }
    return null;
  }

  /* Small thumbnails. The little pictures on screen (ball, folder cards, duplicates) use a small
     JPEG (about 240 px) made once per photo, never the full-size photo: a 12-megapixel picture
     needs about 48 MB of memory to show, which makes phones stall and draw only parts of photos.
     Two are made at a time; a request is skipped when nobody still wants its picture (every wanted() false). */
  const THUMB_PX = 240, THUMB_KEEP = 1500, THUMBS_AT_ONCE = 2;
  const thumbs = new Map();            // file → { rec, p: Promise<url|null> }, oldest first
  const thumbQueue = [];
  let thumbsBusy = 0;

  async function shrink(file) {
    let src, url = null;
    try {
      try { src = await createImageBitmap(file, { resizeWidth: THUMB_PX, resizeQuality: "medium" }); }
      catch (e) {
        url = URL.createObjectURL(file);
        src = new Image();
        src.src = url;
        await src.decode();
      }
      const w = src.width, h = src.height, k = Math.min(1, THUMB_PX / Math.min(w, h));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.82));
      c.width = c.height = 0;
      return blob ? URL.createObjectURL(blob) : null;
    } catch (e) {
      return null;
    } finally {
      if (src && src.close) src.close();
      if (url) URL.revokeObjectURL(url);
    }
  }

  function pumpThumbs() {
    while (thumbsBusy < THUMBS_AT_ONCE && thumbQueue.length) {
      const job = thumbQueue.shift();
      if (!job.wants.some(w => !w || w())) { thumbs.delete(job.file); job.done(null); continue; }
      thumbsBusy++;
      const entry = thumbs.get(job.file);
      if (entry) entry.job = null;      // started: no more wants to collect
      shrink(job.file).then(u => {
        thumbsBusy--;
        job.rec.thumbUrl = u;
        job.done(u);
        pumpThumbs();
      });
    }
  }

  /** Promise of a small picture URL for a photo record (null for videos and formats the browser can't show). */
  function thumb(rec, wanted) {
    if (rec.thumbUrl) return Promise.resolve(rec.thumbUrl);
    if (rec.kind !== "photo" || !canPreview(rec.name)) return Promise.resolve(null);
    let entry = thumbs.get(rec.file);
    if (entry) { if (entry.job) entry.job.wants.push(wanted); }
    else {
      const job = { rec, file: rec.file, wants: [wanted] };
      entry = { rec, job, p: new Promise(done => { job.done = done; thumbQueue.push(job); }) };
      thumbs.set(rec.file, entry);
      // keep memory bounded: forget the oldest small pictures past THUMB_KEEP
      while (thumbs.size > THUMB_KEEP) {
        const [f, old] = thumbs.entries().next().value;
        thumbs.delete(f);
        old.p.then(u => { if (u) { URL.revokeObjectURL(u); if (old.rec.thumbUrl === u) old.rec.thumbUrl = null; } });
      }
      setTimeout(pumpThumbs);   // after the caller has put its picture on the page (wanted() checks that)
    }
    return entry.p;
  }

  window.GalleryScan = { kindOf, canPreview, extOf, scanDirectory, scanEntry, fileRecord, fromFileList, relation, breathe, thumb };
})();
