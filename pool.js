/* Gallery Organizer: background workers.
   Opening thousands of files is the slowest part of reading dates and finding duplicates.
   A few workers do it on other processor cores, so it is faster and the page never freezes.
   Workers are made from inline code (a blob: URL), so this also works when index.html is
   opened by double-click and in the online preview. If workers can't start, callers fall back
   to doing the same work on the page. */
(function () {
  "use strict";

  const WORKER_CODE = `
    const WHOLE_FILE_LIMIT = 64 * 1024 * 1024, SAMPLE = 4 * 1024 * 1024;
    async function sha256(buf) {
      const h = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, "0")).join("");
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
    onmessage = async e => {
      const { id, task, items } = e.data;
      try {
        if (task === "head") {
          // first bytes of each file (where the camera data lives)
          const out = await Promise.all(items.map(it => it.file.slice(0, it.bytes).arrayBuffer().catch(() => null)));
          postMessage({ id, out }, out.filter(Boolean));
        } else if (task === "hash") {
          // one at a time: big videos would otherwise fill the memory
          const out = [];
          for (const it of items) out.push(await fingerprint(it.file).catch(() => null));
          postMessage({ id, out });
        } else if (task === "ping") postMessage({ id });
      } catch (err) {
        postMessage({ id, error: String(err) });
      }
    };`;

  const size = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  let workers = [];
  try {
    const url = URL.createObjectURL(new Blob([WORKER_CODE], { type: "text/javascript" }));
    workers = Array.from({ length: size }, () => new Worker(url));
  } catch (err) {
    workers = [];
  }

  const pending = new Map();
  let nextId = 1, turn = 0;
  workers.forEach(w => {
    w.onmessage = e => {
      if (e.data.id === 0) { w.ok = true; return; }
      const job = pending.get(e.data.id);
      if (!job) return;
      pending.delete(e.data.id);
      clearTimeout(job.timer);
      if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.out);
    };
    w.onerror = () => broken(w);
    w.postMessage({ id: 0, task: "ping" });
  });
  // A worker that hasn't said hello within 4 s never started (some pages block them): read on the page instead
  setTimeout(() => workers.forEach(w => { if (!w.ok) broken(w); }), 4000);
  // A broken worker (or one a page like the online preview never lets start): stop using it and fail
  // everything it had, so callers fall back to reading on the page.
  function broken(w) {
    w.dead = true;
    for (const [id, job] of pending) { if (job.worker === w) { pending.delete(id); clearTimeout(job.timer); job.reject(new Error("worker failed")); } }
  }

  /** Run a task ("head" or "hash") on a batch of items in the next worker. Resolves with one result per item. */
  function run(task, items) {
    const live = workers.filter(w => !w.dead);
    if (!live.length) return Promise.reject(new Error("no workers"));
    const worker = live[turn++ % live.length];
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // Reading dates never takes long: no answer in 15 s means the worker is stuck, so give up on it
      const timer = task === "head" ? setTimeout(() => { if (pending.has(id)) broken(worker); }, 15000) : 0;
      pending.set(id, { resolve, reject, worker, timer });
      worker.postMessage({ id, task, items });
    });
  }

  window.GalleryPool = { run, size: workers.length, get available() { return workers.some(w => !w.dead); } };
})();
