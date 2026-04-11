#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ===== CONFIG =====
const PBF_PATH = path.join(__dirname, 'france-260408.osm.pbf');
const TILES_DIR = path.join(__dirname, 'tiles');
const TILE_DEG = 0.1;
const HIGHWAYS = new Set(['track', 'path', 'unclassified']);
const KEEP_TAGS = new Set(['highway', 'surface', 'tracktype', 'name', 'smoothness', 'trail_visibility', 'sac_scale']);
const CHUNK = 200000; // process ways in chunks to bound memory

function findIndex(arr, len, val) {
  let lo = 0, hi = len - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] === val) return mid;
    if (arr[mid] < val) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

async function main() {
  if (!fs.existsSync(PBF_PATH)) {
    console.error(`PBF introuvable: ${PBF_PATH}`);
    process.exit(1);
  }

  const pbf = require('osm-pbf-parser');
  const through = require('through2');

  const fileSize = fs.statSync(PBF_PATH).size;
  const heapGB = (require('v8').getHeapStatistics().heap_size_limit / 1e9).toFixed(1);
  console.log(`\n=== Precision Explorer v2 — Extraction pistes ===`);
  console.log(`PBF : ${path.basename(PBF_PATH)} (${(fileSize / 1e9).toFixed(2)} Go)`);
  console.log(`Heap: ${heapGB} Go  |  Chunks: ${fmt(CHUNK)} chemins`);
  console.log(`Dest: ${TILES_DIR}/ (grille ${TILE_DEG}deg)\n`);

  // ============================================================
  // PASS 1 — Read trail ways, collect node refs
  // ============================================================
  console.log('--- Passe 1/2 : Lecture des chemins ---');
  const ways = [];
  const allRefs = [];
  let wCount = 0, bytesRead = 0;
  const t0 = Date.now();

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(PBF_PATH);
    stream.on('data', c => { bytesRead += c.length; });
    stream.pipe(pbf()).pipe(through.obj(function (items, _enc, next) {
      for (const it of items) {
        if (it.type !== 'way') continue;
        const hw = it.tags?.highway;
        if (!hw || !HIGHWAYS.has(hw)) continue;
        const tags = {};
        if (it.tags) for (const [k, v] of Object.entries(it.tags)) {
          if (KEEP_TAGS.has(k)) tags[k] = v;
        }
        ways.push({ id: it.id, tags, refs: it.refs });
        for (const r of it.refs) allRefs.push(r);
        wCount++;
        if (wCount % 200000 === 0) console.log(`  ${fmt(wCount)} chemins  (${fmt(allRefs.length)} refs)  ${(bytesRead / fileSize * 100).toFixed(0)}%`);
      }
      next();
    })).on('finish', resolve).on('error', reject);
  });

  console.log(`  => ${fmt(wCount)} chemins, ${fmt(allRefs.length)} refs`);
  console.log(`  Passe 1: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  // ============================================================
  // Sort + dedup → Float64Array
  // ============================================================
  console.log('--- Tri + deduplication ---');
  allRefs.sort((a, b) => a - b);
  let uCount = 0;
  for (let i = 0; i < allRefs.length; i++) {
    if (i === 0 || allRefs[i] !== allRefs[i - 1]) allRefs[uCount++] = allRefs[i];
  }
  const nodeIds = new Float64Array(uCount);
  for (let i = 0; i < uCount; i++) nodeIds[i] = allRefs[i];
  allRefs.length = 0;

  const nodeLats = new Float64Array(uCount);
  const nodeLons = new Float64Array(uCount);
  console.log(`  ${fmt(uCount)} noeuds uniques (${(nodeIds.byteLength / 1e6).toFixed(0)} Mo)\n`);

  // ============================================================
  // PASS 2 — Read node coordinates
  // ============================================================
  console.log('--- Passe 2/2 : Lecture des coordonnees ---');
  let found = 0;
  bytesRead = 0;
  const t2 = Date.now();

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(PBF_PATH);
    stream.on('data', c => { bytesRead += c.length; });
    stream.pipe(pbf()).pipe(through.obj(function (items, _enc, next) {
      for (const it of items) {
        if (it.type !== 'node') continue;
        const idx = findIndex(nodeIds, uCount, it.id);
        if (idx >= 0) {
          nodeLats[idx] = it.lat;
          nodeLons[idx] = it.lon;
          found++;
          if (found % 2000000 === 0) console.log(`  ${fmt(found)} noeuds  ${(bytesRead / fileSize * 100).toFixed(0)}%`);
        }
      }
      next();
    })).on('finish', resolve).on('error', reject);
  });

  console.log(`  => ${fmt(found)} / ${fmt(uCount)} noeuds trouves`);
  console.log(`  Passe 2: ${((Date.now() - t2) / 1000).toFixed(0)}s\n`);

  // ============================================================
  // BUILD TILES — chunk-based, write to disk incrementally
  // Uses NDJSON (one JSON element per line) as intermediate format
  // ============================================================
  console.log('--- Construction des tuiles (par chunks) ---');
  if (!fs.existsSync(TILES_DIR)) fs.mkdirSync(TILES_DIR, { recursive: true });

  let valid = 0, skipped = 0;
  const allTileKeys = new Set();

  for (let start = 0; start < ways.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, ways.length);
    const chunkTiles = new Map(); // tileKey -> string[] (element JSON lines)

    for (let wi = start; wi < end; wi++) {
      const way = ways[wi];
      const tileKeys = new Set();
      let geomJson = '';
      let ok = true;

      for (let ri = 0; ri < way.refs.length; ri++) {
        const idx = findIndex(nodeIds, uCount, way.refs[ri]);
        if (idx < 0 || (nodeLats[idx] === 0 && nodeLons[idx] === 0)) { ok = false; break; }
        const lat = Math.round(nodeLats[idx] * 1e6) / 1e6;
        const lon = Math.round(nodeLons[idx] * 1e6) / 1e6;
        if (ri > 0) geomJson += ',';
        geomJson += `{"lat":${lat},"lon":${lon}}`;
        tileKeys.add(`${Math.floor(lat / TILE_DEG)}_${Math.floor(lon / TILE_DEG)}`);
      }

      way.refs = null; // free refs

      if (!ok || geomJson.indexOf(',') === -1) { skipped++; continue; }
      valid++;

      const elStr = `{"type":"way","id":${way.id},"tags":${JSON.stringify(way.tags)},"geometry":[${geomJson}]}`;

      for (const tk of tileKeys) {
        if (!chunkTiles.has(tk)) chunkTiles.set(tk, []);
        chunkTiles.get(tk).push(elStr);
        allTileKeys.add(tk);
      }
    }

    // Flush this chunk's data to disk (append NDJSON)
    for (const [key, lines] of chunkTiles) {
      fs.appendFileSync(path.join(TILES_DIR, `${key}.ndjson`), lines.join('\n') + '\n');
    }

    console.log(`  ${fmt(end)} / ${fmt(ways.length)} chemins  (${allTileKeys.size} tuiles)`);
  }

  // Free large arrays
  ways.length = 0;

  console.log(`  => ${fmt(valid)} valides, ${fmt(skipped)} ignores\n`);

  // ============================================================
  // CONVERT NDJSON → JSON.GZ (compressed, ~70% smaller)
  // ============================================================
  console.log('--- Conversion NDJSON → JSON.GZ ---');
  let written = 0, totalBytes = 0, totalRaw = 0;
  const ndjsonFiles = fs.readdirSync(TILES_DIR).filter(f => f.endsWith('.ndjson'));

  for (const file of ndjsonFiles) {
    const ndjsonPath = path.join(TILES_DIR, file);
    const content = fs.readFileSync(ndjsonPath, 'utf8').trimEnd();
    const jsonContent = `{"elements":[${content.split('\n').join(',')}]}`;
    totalRaw += jsonContent.length;
    const gzipped = zlib.gzipSync(jsonContent, { level: 9 });
    const gzPath = path.join(TILES_DIR, file.replace('.ndjson', '.json.gz'));
    fs.writeFileSync(gzPath, gzipped);
    fs.unlinkSync(ndjsonPath);
    totalBytes += gzipped.length;
    written++;
    if (written % 2000 === 0) console.log(`  ${written}/${ndjsonFiles.length} tuiles (${(totalBytes / 1e6).toFixed(0)} Mo gz / ${(totalRaw / 1e6).toFixed(0)} Mo raw)`);
  }

  // Metadata
  const meta = {
    date: new Date().toISOString().split('T')[0],
    source: path.basename(PBF_PATH),
    tileDeg: TILE_DEG,
    tiles: written,
    ways: valid,
    highways: [...HIGHWAYS],
    sizeMB: Math.round(totalBytes / 1e6)
  };
  fs.writeFileSync(path.join(TILES_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  const totalMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n=== Termine ! ===`);
  console.log(`${written} tuiles — ${(totalBytes / 1e6).toFixed(0)} Mo (gzip, ${(totalRaw / 1e6).toFixed(0)} Mo raw, ratio ${(totalBytes / totalRaw * 100).toFixed(0)}%)`);
  console.log(`Duree totale: ${totalMin} min\n`);
}

main().catch(err => { console.error('\nERREUR:', err.message || err); process.exit(1); });
