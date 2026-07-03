const $ = (id) => document.getElementById(id);
chrome.storage.local.get({ host: 'http://localhost:7777', key: '' }, (cfg) => {
  $('host').value = cfg.host;
  $('key').value = cfg.key;
});
$('save').onclick = () => {
  chrome.storage.local.set({ host: $('host').value.trim() || 'http://localhost:7777', key: $('key').value }, () => {
    $('ok').textContent = 'Kaydedildi ✓';
    setTimeout(() => { $('ok').textContent = ''; }, 1500);
  });
};
