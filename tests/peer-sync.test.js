'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReplica, compareVectors, mergeVectors } = require('../peer-sync');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notlar-peer-sync-'));
const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
process.on('exit', cleanup);

function makeSide(name, deviceId, options = {}) {
  const dataDir = path.join(root, name);
  const notesDir = path.join(dataDir, 'notes');
  fs.mkdirSync(notesDir, { recursive: true, mode: 0o700 });
  const applied = [];
  const replica = createReplica({
    dataDir,
    notesDir,
    deviceId,
    deviceName: name,
    autoStart: false,
    ...options,
    onApplied: (event) => applied.push(event),
  });
  return { dataDir, notesDir, replica, applied };
}

function noteFile(side, name) {
  return path.join(side.notesDir, ...name.split('/')) + '.md';
}

function write(side, name, content) {
  const file = noteFile(side, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  side.replica.noteChanged(name);
}

function read(side, name) {
  return fs.readFileSync(noteFile(side, name), 'utf8');
}

function names(side) {
  const out = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith('.md')) out.push(rel.slice(0, -3));
    }
  };
  walk(side.notesDir);
  return out.sort();
}

async function transfer(from, to) {
  const packet = from.replica.changes(0);
  return to.replica.applyRecords(packet.records, async (name, expectedHash) => {
    const content = from.replica.readVersion(name, expectedHash);
    assert.strictEqual(from.replica.hashContent(content), expectedHash);
    return content;
  }, from.replica.identity().deviceId);
}

async function main() {
  assert.strictEqual(compareVectors({ a: 2 }, { a: 1 }), 'local');
  assert.strictEqual(compareVectors({ a: 1 }, { a: 2 }), 'remote');
  assert.strictEqual(compareVectors({ a: 1 }, { b: 1 }), 'concurrent');
  assert.deepStrictEqual(mergeVectors({ a: 2 }, { a: 1, b: 3 }), { a: 2, b: 3 });

  const paged = makeSide('Sayfali', 'device-page', { maxChanges: 2 });
  write(paged, 'Bir', '1'); write(paged, 'Iki', '2'); write(paged, 'Uc', '3');
  const firstPage = paged.replica.changes(0);
  const secondPage = paged.replica.changes(firstPage.revision);
  assert.strictEqual(firstPage.records.length, 2);
  assert.strictEqual(firstPage.more, true);
  assert.strictEqual(secondPage.records.length, 1);
  assert.strictEqual(secondPage.more, false);
  assert.deepStrictEqual([...firstPage.records, ...secondPage.records].map((record) => record.name).sort(), ['Bir', 'Iki', 'Uc']);
  paged.replica.close();

  const a = makeSide('Masaustu', 'device-a');
  const b = makeSide('Dizustu', 'device-b');

  // İlk kopya: bir cihazda yazılan not ötekine içerik ve vector ile gelir.
  write(a, 'Projeler/Ortak', 'ilk sürüm');
  await transfer(a, b);
  assert.strictEqual(read(b, 'Projeler/Ortak'), 'ilk sürüm');
  assert.deepStrictEqual(b.replica.getRecord('Projeler/Ortak').vector, { 'device-a': 1 });

  // İki cihaz çevrimdışıyken aynı notu değiştirir: deterministik ana sürüm ve
  // deterministik çakışma kopyası iki tarafta da birebir aynı olmalı.
  write(a, 'Projeler/Ortak', 'masaüstü çevrimdışı değişiklik');
  write(b, 'Projeler/Ortak', 'dizüstü çevrimdışı değişiklik');
  const aPacket = a.replica.changes(0);
  const bPacket = b.replica.changes(0);
  await a.replica.applyRecords(bPacket.records,
    async (name, expectedHash) => b.replica.readVersion(name, expectedHash), 'device-b');
  await b.replica.applyRecords(aPacket.records,
    async (name, expectedHash) => a.replica.readVersion(name, expectedHash), 'device-a');

  assert.strictEqual(read(a, 'Projeler/Ortak'), read(b, 'Projeler/Ortak'));
  const aNames = names(a);
  const bNames = names(b);
  assert.deepStrictEqual(aNames, bNames);
  const conflict = aNames.find((name) => name.startsWith('Projeler/Ortak - çakışma '));
  assert(conflict, 'çakışma kopyası oluşmalı');
  assert.strictEqual(read(a, conflict), read(b, conflict));
  assert.notStrictEqual(read(a, conflict), read(a, 'Projeler/Ortak'));

  // Uzak icerik agdan gelirken ayni not bu cihazda kaydedilirse, fetch oncesi
  // alinmis eski state yeni yerel yaziyi ezmemeli; iki surum de korunmali.
  write(a, 'Yaris', 'ortak yaris tabani');
  await transfer(a, b);
  write(a, 'Yaris', 'agdan gelen yeni surum');
  const racePacket = a.replica.changes(0);
  let localRaceWritten = false;
  await b.replica.applyRecords(racePacket.records, async (name, expectedHash) => {
    if (name === 'Yaris' && !localRaceWritten) {
      localRaceWritten = true;
      write(b, 'Yaris', 'fetch sirasinda yerel surum');
    }
    return a.replica.readVersion(name, expectedHash);
  }, 'device-a');
  const raceNames = names(b).filter((name) => name === 'Yaris' || name.startsWith('Yaris - çakışma '));
  assert.strictEqual(raceNames.length, 2, 'fetch sirasindaki yerel yazi ayri surumde korunmali');
  assert.deepStrictEqual(new Set(raceNames.map((name) => read(b, name))), new Set([
    'agdan gelen yeni surum', 'fetch sirasinda yerel surum',
  ]));

  // Tek taraftaki silme, diğer taraf silmeden önce o sürümü görmüşse nedensel
  // olarak üstün olur ve tombstone ile yayılır.
  const file = noteFile(a, 'Projeler/Ortak');
  fs.unlinkSync(file);
  a.replica.noteDeleted('Projeler/Ortak');
  await transfer(a, b);
  assert.strictEqual(fs.existsSync(noteFile(b, 'Projeler/Ortak')), false);
  assert.strictEqual(b.replica.getRecord('Projeler/Ortak').deleted, true);

  // Dizin/dosya izinleri ve gizli peer tokenlarının public durumdan çıkmaması.
  assert.strictEqual(fs.statSync(path.join(a.dataDir, 'sync')).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(a.dataDir, 'sync', 'state.json')).mode & 0o777, 0o600);
  assert(!JSON.stringify(a.replica.status()).includes('outboundToken'));

  a.replica.close();
  b.replica.close();
  console.log('peer-sync: ok');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
