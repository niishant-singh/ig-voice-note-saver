(() => {
  if (window.__igvnLoaded) return;
  window.__igvnLoaded = true;

  // ---------- Tunable settings ----------
  const CFG = {
    scrollSettleMs: 1200,   // wait after jumping to the oldest end so older messages load
    idleScrollsToStop: 5,   // stop loading history after N scrolls with no growth
    stepSettleMs: 500,      // wait after each step down the thread
    captureTimeoutMs: 6000, // max wait for a voice note's audio to show up
    pollMs: 150,
  };

  // Matches the play button's aria-label. Adjust if the popup finds 0 notes.
  const PRIMARY_LABEL = /(play).*(audio|voice)|(audio|voice).*(play)/i;
  const FALLBACK_LABEL = /^play$/i;

  let state = { running: false, stop: false, saved: 0, skipped: 0, failed: 0, phase: 'Idle', lastError: '' };
  let pageHits = [];            // audio sources reported by page-hook.js
  const debugLines = [];
  const seenBlobs = new Set();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r); });
      } catch { resolve(undefined); }
    });
  const log = (line) => {
    debugLines.push(line);
    if (debugLines.length > 80) debugLines.shift();
    console.log('[IGVN]', line);
  };
  const strip = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u).slice(0, 80); } };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__igvn) return;
    pageHits.push({ kind: e.data.kind, url: e.data.url });
  });

  // ---------- Finding things in the page ----------
  function hasVideoNearby(el) {
    let p = el;
    for (let i = 0; i < 4 && p; i++) {
      if (p.querySelector && p.querySelector('video')) return true;
      p = p.parentElement;
    }
    return false;
  }

  function findPlayButtons() {
    const root = document.querySelector('[role="main"]') || document.body;
    const labelled = [...root.querySelectorAll('[aria-label]')];
    let hits = labelled.filter((el) => PRIMARY_LABEL.test(el.getAttribute('aria-label')));
    if (!hits.length) {
      hits = labelled.filter(
        (el) => FALLBACK_LABEL.test(el.getAttribute('aria-label')) && !hasVideoNearby(el)
      );
    }
    return hits.filter((el) => !hits.some((o) => o !== el && o.contains(el))); // outermost only
  }

  function getScroller() {
    const root = document.querySelector('[role="main"]') || document.body;
    let best = null, bestArea = 0;
    for (const el of root.querySelectorAll('div')) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 50) {
        const area = el.clientHeight * el.clientWidth;
        if (area > bestArea) { best = el; bestArea = area; }
      }
    }
    return best;
  }

  function chatName() {
    const h = document.querySelector('[role="main"] header, [role="main"] h1, [role="main"] h2');
    const raw = ((h && h.innerText) || '').split('\n')[0].trim() || 'chat';
    return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 60) || 'chat';
  }

  // ---------- The bulk run ----------
  async function loadFullHistory(sc) {
    let idle = 0, last = -1;
    while (!state.stop && idle < CFG.idleScrollsToStop) {
      sc.scrollTop = -1e9; // clamps to the oldest end for normal AND column-reverse lists
      await sleep(CFG.scrollSettleMs);
      const h = sc.scrollHeight;
      idle = h === last ? idle + 1 : 0;
      last = h;
      state.phase = 'Loading older messages…';
      render();
    }
  }

  async function waitForCapture() {
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.captureTimeoutMs && !state.stop) {
      const r = await send({ type: 'CAPTURE_POLL' });
      const bg = (r && r.urls) || [];
      if (bg.length) return { url: bg[0], via: 'network' };
      const web = pageHits.find((h) => /^https?:/.test(h.url));
      if (web) return { url: web.url, via: 'page-' + web.kind };
      const blob = pageHits.find((h) => h.url.startsWith('blob:'));
      if (blob) return { url: blob.url, via: 'page-' + blob.kind };
      await sleep(CFG.pollMs);
    }
    return null;
  }

  async function saveBlob(url, chat, idx) {
    const blob = await (await fetch(url)).blob();
    const key = blob.size + ':' + blob.type;
    if (seenBlobs.has(key)) return { duplicate: true };
    seenBlobs.add(key);
    const ext = /mpeg/.test(blob.type) ? 'mp3' : /ogg/.test(blob.type) ? 'ogg' : /webm/.test(blob.type) ? 'webm' : 'm4a';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `IG-${chat}-${idx}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return { ok: true };
  }

  function silence(btn) {
    if (/pause/i.test(btn.getAttribute('aria-label') || '')) btn.click();
    document.querySelectorAll('audio').forEach((a) => { try { a.pause(); } catch {} });
  }

  async function saveOne(btn, chat) {
    const label = btn.getAttribute('aria-label') || '';
    btn.scrollIntoView({ block: 'center' });
    await sleep(250);
    await send({ type: 'CAPTURE_RESET' });
    pageHits = [];
    btn.click();
    const cap = await waitForCapture();
    const dbg = await send({ type: 'CAPTURE_DEBUG' });
    silence(btn);

    if (!cap) {
      state.failed++;
      state.lastError = 'No audio seen after clicking play';
      log(`FAIL no-capture | label="${label}" | pageHits=${JSON.stringify(pageHits.map((h) => h.kind + ':' + strip(h.url)))} | network(last 8)=${JSON.stringify(((dbg && dbg.seen) || []).slice(-8))}`);
      render();
      return;
    }

    const idx = String(state.saved + 1).padStart(3, '0');
    let result = 'failed', err = '';
    try {
      if (cap.url.startsWith('blob:')) {
        const r = await saveBlob(cap.url, chat, idx);
        result = r.duplicate ? 'duplicate' : 'ok';
      } else {
        const res = await send({ type: 'DOWNLOAD', url: cap.url, filename: `IG Voice Notes/${chat}/${idx}.m4a` });
        if (res && res.duplicate) result = 'duplicate';
        else if (res && res.ok) result = 'ok';
        else err = (res && res.error) || 'no response from background';
      }
    } catch (e) { err = e.message; }

    if (result === 'duplicate') state.skipped++;
    else if (result === 'ok') state.saved++;
    else { state.failed++; state.lastError = 'Download failed: ' + err; }
    log(`${result.toUpperCase()} via ${cap.via} | ${strip(cap.url)} ${err ? '| ' + err : ''}`);
    render();
  }

  async function walkAndSave(sc) {
    const done = new WeakSet();
    const chat = chatName();
    const pass = async () => {
      for (const btn of findPlayButtons()) {
        if (state.stop) return;
        if (done.has(btn)) continue;
        done.add(btn);
        state.phase = 'Saving voice notes…';
        await saveOne(btn, chat);
      }
    };
    sc.scrollTop = -1e9; // back to the oldest end
    await sleep(500);
    while (!state.stop) {
      await pass();
      const before = sc.scrollTop;
      sc.scrollBy({ top: Math.floor(sc.clientHeight * 0.6), behavior: 'instant' });
      await sleep(CFG.stepSettleMs);
      if (Math.abs(sc.scrollTop - before) < 2) break; // can't move further = newest reached
    }
    await pass();
  }

  async function run() {
    if (state.running) return;
    state = { running: true, stop: false, saved: 0, skipped: 0, failed: 0, phase: 'Starting…', lastError: '' };
    seenBlobs.clear();
    render();
    await send({ type: 'CAPTURE_START' });
    try {
      const sc = getScroller();
      if (!sc) throw new Error('Could not find the chat scroll area. Open a chat first.');
      log('scroll container flex-direction=' + getComputedStyle(sc).flexDirection);
      const prev = sc.style.outline;
      sc.style.outline = '3px solid red';
      setTimeout(() => { sc.style.outline = prev; }, 1500);
      await loadFullHistory(sc);
      await walkAndSave(sc);
      state.phase = state.stop ? 'Stopped' : 'Done';
    } catch (e) {
      state.phase = 'Error: ' + e.message;
    } finally {
      await send({ type: 'CAPTURE_STOP' });
      state.running = false;
      render();
    }
  }

  // ---------- Small in-page status pill ----------
  let pill;
  function render() {
    if (!state.running && state.phase === 'Idle') return;
    if (!pill) {
      pill = document.createElement('div');
      pill.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#111;color:#fff;' +
        'font:13px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:10px;max-width:320px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center';
      pill.innerHTML = '<span id="igvn-text"></span><button id="igvn-stop" style="all:unset;cursor:pointer;' +
        'padding:3px 8px;border-radius:6px;background:#e0245e">Stop</button>';
      document.body.appendChild(pill);
      pill.querySelector('#igvn-stop').onclick = () => {
        if (state.running) state.stop = true; else { pill.remove(); pill = null; }
      };
    }
    pill.querySelector('#igvn-text').textContent =
      `${state.phase}  ·  saved ${state.saved}` +
      (state.skipped ? `, duplicates ${state.skipped}` : '') +
      (state.failed ? `, failed ${state.failed}` : '') +
      (state.lastError ? `  (${state.lastError})` : '');
    pill.querySelector('#igvn-stop').textContent = state.running ? 'Stop' : 'Close';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'COUNT') reply({ count: findPlayButtons().length });
    else if (msg.type === 'START') { run(); reply({ ok: true }); }
    else if (msg.type === 'STOP') { state.stop = true; reply({ ok: true }); }
    else if (msg.type === 'STATUS') reply({ ...state });
    else if (msg.type === 'DEBUG') reply({ text: debugLines.join('\n') || '(no log yet)' });
  });
})();
