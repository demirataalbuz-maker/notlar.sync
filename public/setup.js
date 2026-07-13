'use strict';

const api = window.setupApi;
const query = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
let busy = false;
let pollTimer = null;

async function finish(patch = {}) {
  await api.patchConfig({ ...patch, setupDone: true });
  api.done();
}

$('atla').onclick = () => finish({ tailscaleSkip: true });

$('baglanBtn').onclick = async () => {
  const address = $('adres').value.trim().replace(/\/$/, '');
  const code = $('kod').value.trim();
  const deviceName = $('cihazAd').value.trim() || 'Isimsiz cihaz';
  $('pairErr').textContent = ''; $('pairDurum').textContent = '';
  try {
    const parsed = new URL(address);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch { $('pairErr').textContent = 'Gecerli bir http veya https adresi gir.'; return; }
  if (!/^\d{6}$/.test(code)) { $('pairErr').textContent = 'Kod 6 haneli olmali.'; return; }
  $('baglanBtn').disabled = true;
  try {
    const claim = await api.pairClaim({ address, code, deviceName });
    await api.pairApprove({ address, code, claimId: claim.claimId });
    $('pairDurum').textContent = 'Bu cihaz onaylandi. Ana cihazdaki onay bekleniyor...';
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const state = await api.pairStatus({ address, code, claimId: claim.claimId });
        if (state.durum === 'onaylandi' && state.token) {
          clearInterval(pollTimer);
          $('pairDurum').textContent = 'Eslestirme tamamlandi. Baglaniliyor...';
          await finish({ mode: 'client', server: address, password: state.token });
        } else if (state.durum === 'yok') {
          clearInterval(pollTimer);
          $('baglanBtn').disabled = false;
          $('pairErr').textContent = 'Kodun suresi gecti veya eslestirme iptal edildi.';
        }
      } catch {}
    }, 1500);
  } catch (error) {
    $('baglanBtn').disabled = false;
    $('pairErr').textContent = 'Baglanamadi: ' + String(error.message || error).slice(0, 100);
  }
};

async function install() {
  if (api.platform !== 'linux') {
    await api.openUrl('https://tailscale.com/download');
    $('durum').textContent = 'Indirme sayfasi acildi. Kurulumdan sonra durum otomatik yenilenecek.';
    return;
  }
  busy = true; $('ana').disabled = true;
  $('durum').textContent = 'Kuruluyor. Sistem parolasi istenebilir.';
  const result = await api.installTailscale();
  busy = false; $('ana').disabled = false;
  if (!result.ok) $('durum').textContent = 'Kurulum tamamlanamadi: ' + result.error;
  await refreshStatus();
}

async function login() {
  busy = true; $('ana').disabled = true;
  $('durum').textContent = 'Tailscale giris baglantisi bekleniyor...';
  try { await api.tailscaleUp(); }
  catch (error) { busy = false; $('durum').textContent = String(error.message || error); }
}

api.onLoginUrl(async (url) => {
  await api.openUrl(url);
  busy = false; $('ana').disabled = false;
  $('durum').textContent = 'Tarayicida Tailscale onayi bekleniyor.';
});

function renderRunning(state) {
  const status = $('durum'); status.innerHTML = '';
  status.append('Bagli. Bu cihazin kalici adresi: ');
  const ip = document.createElement('span'); ip.id = 'ip'; ip.textContent = state.ip; status.appendChild(ip);
  if (query.get('mode') === 'host') status.append(document.createElement('br'), `Diger cihaz adresi: http://${state.ip}:${query.get('port') || 7777}`);
  const button = $('ana');
  button.style.display = ''; button.disabled = false; button.textContent = 'Devam et'; button.onclick = () => finish();
}

async function refreshStatus() {
  if (busy) return;
  const state = await api.status();
  const button = $('ana'); button.disabled = false;
  if (state.state === 'Running') { busy = false; renderRunning(state); return; }
  if (state.state === 'yok') {
    $('durum').textContent = 'Tailscale bu cihazda kurulu degil.';
    button.style.display = ''; button.textContent = api.platform === 'linux' ? 'Tailscale kur' : 'Indirme sayfasini ac'; button.onclick = install;
    return;
  }
  $('durum').textContent = `Tailscale kurulu ancak bagli degil (${state.state}).`;
  button.style.display = ''; button.textContent = 'Giris yap ve baglan'; button.onclick = login;
}

refreshStatus().catch((error) => { $('durum').textContent = String(error.message || error); });
setInterval(() => refreshStatus().catch(() => {}), 3000);
