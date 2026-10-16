(() => {
  if (window.__igvnHook) return;
  window.__igvnHook = true;

  const post = (kind, url) => {
    try { if (url) window.postMessage({ __igvn: true, kind, url: String(url) }, '*'); } catch {}
  };

  // 1) Any <audio>/<video> that starts playing: report its source
  document.addEventListener('play', (e) => {
    const t = e.target;
    if (t instanceof HTMLMediaElement) post('media', t.currentSrc || t.src);
  }, true);

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      post('media', this.currentSrc || this.src);
      setTimeout(() => post('media', this.currentSrc || this.src), 300);
    } catch {}
    return origPlay.apply(this, args);
  };

  // 2) fetch / XHR responses that are audio
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const ct = res.headers.get('content-type') || '';
      if (/^audio\//.test(ct) || /audioclip/i.test(res.url)) post('fetch', res.url);
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', () => {
      try {
        const ct = this.getResponseHeader('content-type') || '';
        if (/^audio\//.test(ct) || /audioclip/i.test(this.responseURL)) post('xhr', this.responseURL);
      } catch {}
    });
    return origOpen.apply(this, args);
  };

  // 3) Audio blobs the page builds itself
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.call(this, obj);
    try { if (obj instanceof Blob && /^audio\//.test(obj.type)) post('blob', url); } catch {}
    return url;
  };
})();
