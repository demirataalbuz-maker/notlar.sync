const $ = (id) => document.getElementById(id);
chrome.storage.local.get({ host: 'http://localhost:7777', key: '' }, (cfg) => {
  $('host').value = cfg.host;
  $('key').value = cfg.key;
});
$('save').onclick = () => {
  let host = $('host').value.trim() || 'http://localhost:7777';
  try {
    const parsed = new URL(host);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    host = parsed.href.replace(/\/$/, '');
  } catch {
    $('ok').textContent = 'Geçerli bir http/https adresi gir.'; $('ok').style.color = '#ff9b94'; return;
  }
  chrome.storage.local.set({ host, key: $('key').value }, () => {
    $('ok').style.color = '#2ecc71';
    $('ok').textContent = 'Kaydedildi ✓';
    setTimeout(() => { $('ok').textContent = ''; }, 1500);
  });
};
