'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP_DIRS = new Set(['.git', '.trash', 'node_modules', 'NotlarSync', 'dist', 'build']);

function walkForVaults(dir, depth, found) {
  if (depth < 0) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((entry) => entry.isDirectory() && entry.name === '.obsidian')) {
    try { found.add(fs.realpathSync(dir)); } catch {}
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    walkForVaults(path.join(dir, entry.name), depth - 1, found);
  }
}

function discover(home = os.homedir()) {
  const found = new Set();
  const roots = [path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Obsidian')];
  for (const root of roots) if (fs.existsSync(root)) walkForVaults(root, 5, found);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function scan(vaultPath, { readContent = false } = {}) {
  const root = fs.realpathSync(vaultPath);
  if (!fs.statSync(root).isDirectory() || !fs.existsSync(path.join(root, '.obsidian'))) throw new Error('geçerli Obsidian kasası değil');
  const notes = [];
  const assets = [];
  const folders = [];

  function walk(dir, prefix = '') {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === '.obsidian' || entry.name === '.trash' || entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        folders.push(relative);
        walk(absolute, relative);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const stat = fs.statSync(absolute);
        if (stat.size > 10e6) continue;
        notes.push({ relative, absolute, size: stat.size, content: readContent ? fs.readFileSync(absolute, 'utf8') : undefined });
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        if (stat.size <= 100e6) assets.push({ relative, absolute, size: stat.size });
      }
    }
  }
  walk(root);
  return { root, name: path.basename(root), notes, assets, folders };
}

function list(home = os.homedir()) {
  return discover(home).map((vaultPath) => {
    const data = scan(vaultPath);
    return {
      path: data.root,
      name: data.name,
      notes: data.notes.length,
      assets: data.assets.length,
      folders: data.folders.length,
    };
  });
}

module.exports = { discover, scan, list };
