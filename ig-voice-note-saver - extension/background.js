// Captures audio URLs that Instagram loads while the content script is
// "playing" each voice note, then downloads them.

const captures = new Map();   // tabId -> { urls: [], seen: [] }
const downloaded = new Set(); // path-keys already saved in this run

const keyOf = (url) => {
  try { const u = new URL(url); return u.origin + u.pathname; } // ignore signed query params
  catch { return url; }
};

chrome.webRequest.onCompleted.addListener(
  (d) => {
    const c = captures.get(d.tabId);
    if (!c) return; // only listen while a bulk run is active
    const ct = (d.responseHeaders || [])
      .find((h) => h.name.toLowerCase() === 'content-type')?.value || '';

    c.seen.push(`${d.type}|${ct}|${keyOf(d.url).slice(-70)}`); // for debugging only
    if (c.seen.length > 60) c.seen.shift();

    const looksLikeAudio =
      /^audio\//.test(ct) ||
      /audioclip/i.test(d.url) ||
      d.type === 'media' ||
      ((d.type === 'xmlhttprequest' || d.type === 'other') && /^(audio|video)\//.test(ct));
    if (!looksLikeAudio) return;
    if (!c.urls.some((u) => keyOf(u) === keyOf(d.url))) c.urls.push(d.url);
  },
  {
    urls: ['https://*.cdninstagram.com/*', 'https://*.fbcdn.net/*'],
    types: ['media', 'xmlhttprequest', 'other'],
  },
  ['responseHeaders']
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case 'CAPTURE_START':
      captures.set(tabId, { urls: [], seen: [] });
      downloaded.clear();
      chrome.tabs.update(tabId, { muted: true }); // notes get "played" silently
      sendResponse({ ok: true });
      break;

    case 'CAPTURE_RESET':
      if (captures.has(tabId)) captures.get(tabId).urls = [];
      sendResponse({ ok: true });
      break;

    case 'CAPTURE_POLL':
      sendResponse({ urls: [...(captures.get(tabId)?.urls || [])] });
      break;

    case 'CAPTURE_DEBUG':
      sendResponse({ seen: [...(captures.get(tabId)?.seen || [])] });
      break;

    case 'CAPTURE_STOP':
      captures.delete(tabId);
      chrome.tabs.update(tabId, { muted: false });
      sendResponse({ ok: true });
      break;

    case 'DOWNLOAD': {
      const k = keyOf(msg.url);
      if (downloaded.has(k)) { sendResponse({ duplicate: true }); break; }
      downloaded.add(k);
      chrome.downloads.download(
        { url: msg.url, filename: msg.filename, conflictAction: 'uniquify' },
        (id) => {
          if (chrome.runtime.lastError || id === undefined) {
            downloaded.delete(k);
            sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'download failed' });
          } else {
            sendResponse({ ok: true });
          }
        }
      );
      return true; // async response
    }
  }
});
