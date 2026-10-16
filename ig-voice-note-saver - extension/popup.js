const $ = (id) => document.getElementById(id);
let tabId;

const ask = async (type) => {
  try { return await chrome.tabs.sendMessage(tabId, { type }); } catch { return null; }
};

async function poll() {
  const s = await ask('STATUS');
  if (!s) { $('status').textContent = 'Reload the Instagram tab, then reopen this popup.'; return; }
  const c = await ask('COUNT');
  $('count').textContent = `${c ? c.count : 0} voice note(s) currently loaded in this chat`;
  $('start').disabled = s.running;
  $('stop').disabled = !s.running;
  $('status').textContent = s.phase === 'Idle' ? '' :
    `${s.phase} · saved ${s.saved}` +
    (s.skipped ? `, duplicates ${s.skipped}` : '') + (s.failed ? `, failed ${s.failed}` : '') +
    (s.lastError ? ` — ${s.lastError}` : '');
}

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (!tab || !tab.url || !tab.url.startsWith('https://www.instagram.com/direct/')) {
    $('count').textContent = 'Open an Instagram DM chat first.';
    $('start').disabled = true;
    $('debug').disabled = true;
    return;
  }
  $('start').onclick = async () => { await ask('START'); poll(); };
  $('stop').onclick = async () => { await ask('STOP'); poll(); };
  $('debug').onclick = async () => {
    const r = await ask('DEBUG');
    try { await navigator.clipboard.writeText(r ? r.text : '(no response)'); $('status').textContent = 'Debug info copied. Paste it in the chat.'; }
    catch { $('status').textContent = 'Could not copy. Open the page console and look for [IGVN] lines.'; }
  };
  poll();
  setInterval(poll, 700);
})();
