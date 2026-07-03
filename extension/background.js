// Notlar Sync arka plan (service worker).
// Icerik script'inden gelen sifreyi, ayarlardaki host'un GECICI kuyruguna yollar.
// Uygulama (kilidi acikken) oradan alip kullaniciya sorar ve sifreleyip kasaya koyar.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'save') return;
  chrome.storage.local.get({ host: 'http://localhost:7777', key: '' }, (cfg) => {
    const q = cfg.key ? '?key=' + encodeURIComponent(cfg.key) : '';
    fetch(cfg.host.replace(/\/$/, '') + '/api/vault-pending' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.cred),
    }).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, err: String(e) }));
  });
  return true; // async yanit
});
