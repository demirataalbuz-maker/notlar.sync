// Notlar Sync arka plan (service worker).
// Icerik script'inden gelen sifreyi, ayarlardaki host'un GECICI kuyruguna yollar.
// Uygulama (kilidi acikken) oradan alip kullaniciya sorar ve sifreleyip kasaya koyar.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'save') return;
  chrome.storage.local.get({ host: 'http://localhost:7777', key: '' }, (cfg) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.key) headers['X-Api-Key'] = cfg.key;
    fetch(cfg.host.replace(/\/$/, '') + '/api/vault-pending', {
      method: 'POST',
      headers,
      body: JSON.stringify(msg.cred),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      sendResponse({ ok: true });
    })
      .catch((e) => sendResponse({ ok: false, err: String(e) }));
  });
  return true; // async yanit
});
