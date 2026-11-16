/* Gallery Organizer: when and where was each photo taken?
   Date, in order of trust: the camera's own date inside the file (EXIF; for phone videos the
   date in the video's header), then a date in the file name, then the file's modified date.
   Place: the GPS position inside the file, named by places.js ("Spain - Madrid").
   Background workers (pool.js) open the files; the page only reads the date from the bytes. */
(function () {
  "use strict";

  // IMG_20190812_…, IMG-20190812-WA0001, PXL_20190812…, Screenshot 2019-08-12…, 2019.08.12
  const NAME_DATE = /(?:^|[^\d])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/;
  const EXIF_EXT = new Set(["jpg", "jpeg", "jpe", "heic", "heif", "tif", "tiff", "dng", "cr2", "nef", "arw", "orf", "rw2", "pef", "srw"]);
  const JPEG_EXT = new Set(["jpg", "jpeg", "jpe"]);
  const EXIF_OPTIONS = { ifd0: false, exif: ["DateTimeOriginal", "CreateDate"], gps: true, interop: false, ifd1: false };
  // How much of the start of a file holds the camera data: JPEG keeps it right at the start,
  // HEIC and RAW files a little further in.
  const HEAD_BYTES = ext => JPEG_EXT.has(ext) ? 64 * 1024 : 256 * 1024;
  const WHOLE_FILE_FALLBACK_LIMIT = 40 * 1024 * 1024;

  function dateFromName(name) {
    const m = NAME_DATE.exec(name);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d) || d > new Date() ? null : d;
  }

  function pickDate(tags) {
    const d = tags && (tags.DateTimeOriginal || tags.CreateDate);
    return d instanceof Date && !isNaN(d) && d.getFullYear() > 1980 ? d : null;
  }

  function pickGps(tags) {
    const lat = tags && tags.latitude, lon = tags && tags.longitude;
    return typeof lat === "number" && typeof lon === "number" && isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0) ? { lat, lon } : null;
  }

  /** Camera data from the bytes: {date, gps}, each null when missing. */
  async function parseTags(input) {
    try {
      const tags = await window.exifr.parse(input, EXIF_OPTIONS);
      return { date: pickDate(tags), gps: pickGps(tags) };
    } catch (err) { return { date: null, gps: null }; }
  }
  const NOTHING = { date: null, gps: null };

  /* Phone videos (MOV, MP4): find the "moov" box and read the Apple creation date (local time),
     else the mvhd creation time, and an ISO 6709 position like "+40.4168-003.7038+650.000/". */
  const VIDEO_EXT = new Set(["mov", "mp4", "m4v", "3gp"]);
  const QT_EPOCH = Date.UTC(1904, 0, 1);
  const okDate = d => d instanceof Date && !isNaN(d) && d.getFullYear() > 1980 && d <= new Date();
  async function readVideo(file) {
    try {
      let pos = 0, moov = null;
      for (let n = 0; n < 200 && pos + 8 <= file.size; n++) {
        const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
        if (h.byteLength < 8) break;
        let size = h.getUint32(0);
        const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
        if (size === 1 && h.byteLength >= 16) size = h.getUint32(8) * 2 ** 32 + h.getUint32(12);
        else if (size === 0) size = file.size - pos;
        if (size < 8 || !/^[\x20-\x7e\xa9]{4}$/.test(type)) break;   // not a video box: stop
        if (type === "moov") { moov = await file.slice(pos, pos + Math.min(size, 32 * 1024 * 1024)).arrayBuffer(); break; }
        pos += size;
      }
      if (!moov) return NOTHING;
      const bytes = new Uint8Array(moov);
      const text = new TextDecoder("latin1").decode(bytes);
      let date = null;
      const apple = text.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
      if (apple) {
        const [, y, mo, d, h, mi, s] = apple.map(Number);
        const local = new Date(y, mo - 1, d, h, mi, s);
        if (okDate(local)) date = local;
      }
      if (!date) {
        const i = text.indexOf("mvhd");
        if (i >= 0 && i + 16 <= bytes.length) {
          const dv = new DataView(moov), v = bytes[i + 4];
          const secs = v === 1 ? dv.getUint32(i + 8) * 2 ** 32 + dv.getUint32(i + 12) : dv.getUint32(i + 8);
          const d = new Date(QT_EPOCH + secs * 1000);
          if (secs > 0 && okDate(d)) date = d;
        }
      }
      const loc = text.match(/([+-]\d{1,2}\.\d{2,})([+-]\d{1,3}\.\d{2,})/);
      const gps = loc && Math.abs(+loc[1]) <= 90 && Math.abs(+loc[2]) <= 180 ? { lat: +loc[1], lon: +loc[2] } : null;
      return { date, gps };
    } catch (err) { return NOTHING; }
  }

  // Rare: HEIC/RAW camera data further in than the first bytes. JPEGs without camera data
  // (WhatsApp, screenshots) are common, so they never take this slow path.
  function needsWholeFile(rec, head) {
    return !JPEG_EXT.has(rec.ext) && rec.file.size > head && rec.file.size <= WHOLE_FILE_FALLBACK_LIMIT;
  }

  async function tagsFromFile(file, ext) {
    if (VIDEO_EXT.has(ext)) return readVideo(file);
    if (!window.exifr || !EXIF_EXT.has(ext)) return NOTHING;
    const head = HEAD_BYTES(ext);
    let buf = null;
    try { buf = await file.slice(0, head).arrayBuffer(); } catch (err) { return NOTHING; }
    const t = await parseTags(buf);
    if (t.date || !needsWholeFile({ ext, file }, head)) return t;
    return parseTags(file);
  }

  /** Adds rec.date, rec.dateSource ("camera" | "name" | "file"), rec.gps ({lat, lon} or null)
      and rec.place ("Spain - Madrid" or null). */
  function applyDate(rec, tags) {
    tags = tags || NOTHING;
    rec.gps = tags.gps;
    rec.place = tags.gps && window.GalleryPlaces ? window.GalleryPlaces.placeOf(tags.gps.lat, tags.gps.lon) : null;
    const camera = tags.date;
    if (camera) { rec.date = camera; rec.dateSource = "camera"; return rec; }
    const named = dateFromName(rec.name);
    if (named) { rec.date = named; rec.dateSource = "name"; return rec; }
    rec.date = new Date(rec.lastModified);
    rec.dateSource = "file";
    return rec;
  }

  async function readDate(rec) {
    return applyDate(rec, await tagsFromFile(rec.file, rec.ext));
  }

  /**
   * Reads dates for every record added, calling onDone(rec) for each.
   * With workers: batches of files are opened in the background. Without: a few at a time on the page.
   */
  function createQueue(onDone, concurrency = 32) {
    let waiting = [], head = 0;   // a read pointer instead of shift(), which gets slow on long lists
    let running = 0;
    const pool = window.GalleryPool;
    const usePool = () => pool && pool.available && window.exifr;
    const BATCH = 48;
    const finish = rec => { if (!rec.removed) onDone(rec); };
    const take = () => {
      const rec = waiting[head++];
      if (head > 4096 && head * 2 > waiting.length) { waiting = waiting.slice(head); head = 0; }
      return rec;
    };

    async function runBatch(batch) {
      let heads;
      try {
        heads = await pool.run("head", batch.map(r => ({ file: r.file, bytes: HEAD_BYTES(r.ext) })));
      } catch (err) {
        // Workers unavailable or failed: read these on the page instead
        for (const r of batch) finish(await readDate(r));
        return;
      }
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i];
        let t = heads[i] ? await parseTags(heads[i]) : NOTHING;
        if (!t.date && needsWholeFile(r, HEAD_BYTES(r.ext))) t = await parseTags(r.file);
        finish(applyDate(r, t));
      }
    }

    const pump = () => {
      if (usePool()) {
        const maxBatches = pool.size * 2;
        while (running < maxBatches && head < waiting.length) {
          const batch = [];
          while (batch.length < BATCH && head < waiting.length) {
            const r = take();
            if (EXIF_EXT.has(r.ext)) batch.push(r);
            else if (VIDEO_EXT.has(r.ext)) { running++; readDate(r).then(v => { running--; finish(v); pump(); }); }  // a few small reads on the page
            else finish(applyDate(r, null));   // no camera data possible
          }
          if (!batch.length) continue;
          running++;
          runBatch(batch).then(() => { running--; pump(); });
        }
        return;
      }
      while (running < concurrency && head < waiting.length) {
        const rec = take();
        running++;
        readDate(rec).then(r => { running--; finish(r); pump(); });
      }
    };
    // Gather files added in the same moment into fuller batches
    let scheduled = false;
    const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; pump(); }); } };
    return {
      add(rec) { waiting.push(rec); schedule(); },
      get pending() { return waiting.length - head + running; }
    };
  }

  window.GalleryMeta = { readDate, dateFromName, createQueue };
})();
