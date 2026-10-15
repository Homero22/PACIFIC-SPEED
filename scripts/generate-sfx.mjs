#!/usr/bin/env node
/**
 * PACIFIC SPEED — Banco de efectos de sonido (ElevenLabs Sound Effects).
 *
 * Genera los efectos del catálogo con `POST /v1/sound-generation` (modelo eleven_text_to_sound_v2),
 * los masteriza por categoría con ffmpeg y escribe public/assets/sfx/manifest.json. El motor de audio
 * usa estos archivos y, si falta alguno, recurre al efecto sintetizado de siempre.
 *
 * Uso (ver docs/EFECTOS.md):
 *   node scripts/generate-sfx.mjs                     → simulación: lista el catálogo y los segundos a generar
 *   node scripts/generate-sfx.mjs --yes               → genera todo (consume créditos de ElevenLabs)
 *   node scripts/generate-sfx.mjs --yes --only=shield_double,impact_heavy
 *   node scripts/generate-sfx.mjs --remaster          → re-masteriza lo existente (sin API)
 *   node scripts/generate-sfx.mjs --manifest-only     → reconstruye manifest.json
 *
 * Variables (en .env.voices, fuera del repo): ELEVENLABS_API_KEY.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT, fileNameFor, hasFfmpeg, loadVoicesEnv, masterAudio } from './lib/audio-tools.mjs';

const OUT_DIR = path.join(ROOT, 'public/assets/sfx');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');

/**
 * Masterización por categoría: los golpes van más fuertes que la interfaz, y los fondos muy bajos
 * para que no tapen voces ni efectos (el motor además los sube/baja según la tensión).
 */
const CATEGORY = {
  impact: { targetLufs: -14, channels: 2, bitrate: '128k', trim: true },
  shield: { targetLufs: -15, channels: 2, bitrate: '128k', trim: true },
  pickup: { targetLufs: -16, channels: 2, bitrate: '128k', trim: true },
  ui: { targetLufs: -20, channels: 1, bitrate: '96k', trim: true },
  ambience: { targetLufs: -24, channels: 2, bitrate: '128k', trim: false },
  damage_loop: { targetLufs: -22, channels: 2, bitrate: '128k', trim: false }
};

/**
 * Catálogo. Los textos van en inglés porque el modelo de efectos responde mejor así.
 * No nombrar juegos, personajes ni marcas: el sonido debe ser propio.
 */
export const SFX_CATALOG = {
  // ——— Fondos en loop (tensión) ———
  amb_tension_low: {
    category: 'ambience',
    loop: true,
    duration: 20,
    influence: 0.5,
    variants: 1,
    prompt:
      'Dark cinematic tension drone for an action racing game, low pulsing bass, subtle ticking pulse, suspenseful, no melody, no vocals'
  },
  amb_tension_high: {
    category: 'ambience',
    loop: true,
    duration: 20,
    influence: 0.5,
    variants: 1,
    prompt:
      'Intense cinematic action tension loop, fast driving percussion, tense staccato strings, rising pressure and urgency, no melody, no vocals'
  },

  // ——— Choques por nivel de daño ———
  impact_light: {
    category: 'impact',
    duration: 0.8,
    influence: 0.6,
    variants: 3,
    prompt: 'Short metallic vehicle body hit, small dent, quick crunch, close up, punchy'
  },
  impact_medium: {
    category: 'impact',
    duration: 1.2,
    influence: 0.6,
    variants: 3,
    prompt: 'Hard vehicle crash impact, steel denting and crunching, debris scattering, punchy low boom'
  },
  impact_heavy: {
    category: 'impact',
    duration: 1.8,
    influence: 0.6,
    variants: 3,
    prompt:
      'Violent heavy vehicle collision, metal tearing and crushing, deep explosive boom, glass and debris shattering, wide and cinematic'
  },

  // ——— Capas de daño en loop ———
  dmg_sparks: {
    category: 'damage_loop',
    loop: true,
    duration: 10,
    influence: 0.5,
    variants: 1,
    prompt: 'Electrical sparks crackling intermittently from a damaged machine, short circuits and buzzing wires'
  },
  dmg_critical: {
    category: 'damage_loop',
    loop: true,
    duration: 10,
    influence: 0.5,
    variants: 1,
    prompt: 'Damaged metal structure groaning and creaking under heavy stress, rattling loose panels, ominous'
  },

  // ——— Escudos ———
  shield_double: {
    category: 'shield',
    duration: 1.4,
    influence: 0.65,
    variants: 3,
    prompt:
      'Heavy steel armor plates slamming and locking into place, powerful resonant metallic clang, followed by a rising magical shimmer and a deep protective hum, heroic'
  },
  shield_up: {
    category: 'shield',
    duration: 0.7,
    influence: 0.6,
    variants: 2,
    prompt: 'Energy shield powering on, short sci-fi hum swell, clean'
  },
  shield_deflect: {
    category: 'shield',
    duration: 0.7,
    influence: 0.6,
    variants: 3,
    prompt: 'Object hitting an energy shield and bouncing off, bright metallic ring with an electric zap'
  },

  // ——— Destrucción ———
  destroy_metal: {
    category: 'impact',
    duration: 4,
    influence: 0.6,
    variants: 2,
    prompt:
      'Massive metallic vehicle destruction, steel crumpling and tearing apart, big explosion, metal debris raining down with a long rumbling tail'
  },

  // ——— Recogibles y acciones ———
  repair: {
    category: 'pickup',
    duration: 1.2,
    influence: 0.6,
    variants: 2,
    prompt: 'Mechanic ratchet wrench clicks and a short hydraulic hiss, followed by a positive bright chime'
  },
  turbo: {
    category: 'pickup',
    duration: 1.4,
    influence: 0.6,
    variants: 2,
    prompt: 'Turbo boost ignition, powerful rising whoosh with an engine roar'
  },
  radar_ping: {
    category: 'ui',
    duration: 0.8,
    influence: 0.6,
    variants: 2,
    prompt: 'Clean soft futuristic sonar ping'
  },
  reward_rescue: {
    category: 'pickup',
    duration: 1.5,
    influence: 0.6,
    variants: 2,
    prompt: 'Happy cheerful chime sparkle with a small happy puppy bark'
  }
};

function parseArgs(argv) {
  const args = { yes: false, ogg: false, manifestOnly: false, remaster: false, only: null };
  for (const a of argv) {
    if (a === '--yes') args.yes = true;
    else if (a === '--ogg') args.ogg = true;
    else if (a === '--manifest-only') args.manifestOnly = true;
    else if (a === '--remaster') args.remaster = true;
    else if (a.startsWith('--only=')) args.only = new Set(a.slice(7).split(',').filter(Boolean));
    else {
      console.error(`Argumento desconocido: ${a}`);
      process.exit(2);
    }
  }
  if (args.only) {
    const unknown = [...args.only].filter((id) => !(id in SFX_CATALOG));
    if (unknown.length) {
      console.error(`IDs desconocidos: ${unknown.join(', ')}`);
      process.exit(2);
    }
  }
  return args;
}

async function generateSfx(key, spec) {
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: spec.prompt,
      model_id: 'eleven_text_to_sound_v2',
      duration_seconds: spec.duration,
      prompt_influence: spec.influence,
      loop: Boolean(spec.loop)
    })
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const cost = res.headers.get('character-cost') ?? res.headers.get('x-character-count');
  return { audio: Buffer.from(await res.arrayBuffer()), cost: cost === null ? null : Number(cost) };
}

function forEachFile(only, fn) {
  for (const [id, spec] of Object.entries(SFX_CATALOG)) {
    if (only && !only.has(id)) continue;
    for (let i = 0; i < spec.variants; i++) fn(id, spec, i, fileNameFor(id, i));
  }
}

function remasterExisting(only, ogg) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sfx-remaster-'));
  try {
    forEachFile(only, (id, spec, i, file) => {
      const outMp3 = path.join(OUT_DIR, file);
      if (!fs.existsSync(outMp3)) return;
      const src = path.join(tmpDir, file);
      fs.copyFileSync(outMp3, src);
      masterAudio(src, outMp3, ogg ? outMp3.replace(/\.mp3$/, '.ogg') : null, CATEGORY[spec.category]);
      console.log(`  ✓ ${file}`);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** manifest.json: { sounds: { id: { files: [...], loop, category } } } con solo archivos existentes. */
function writeManifest() {
  const existing = new Set(fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : []);
  const sounds = {};
  for (const [id, spec] of Object.entries(SFX_CATALOG)) {
    const files = Array.from({ length: spec.variants }, (_, i) => fileNameFor(id, i)).filter((f) => existing.has(f));
    if (files.length) sounds[id] = { files, loop: Boolean(spec.loop), category: spec.category };
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), sounds }, null, 2) + '\n');
  const total = Object.values(sounds).reduce((n, s) => n + s.files.length, 0);
  const missing = Object.keys(SFX_CATALOG).filter((id) => !sounds[id]);
  console.log(
    `manifest.json: ${total} archivos en ${Object.keys(sounds).length} efectos` +
      (missing.length ? ` (sin audio, usan el sintetizado: ${missing.join(', ')})` : '')
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  loadVoicesEnv();

  if (args.manifestOnly) {
    writeManifest();
    return;
  }
  if (args.remaster) {
    if (!hasFfmpeg()) throw new Error('--remaster requiere ffmpeg en el PATH');
    remasterExisting(args.only, args.ogg);
    writeManifest();
    return;
  }

  const jobs = [];
  forEachFile(args.only, (id, spec, i, file) => jobs.push({ id, spec, file }));
  const seconds = jobs.reduce((n, j) => n + j.spec.duration, 0);

  console.log(`Catálogo: ${jobs.length} archivos, ${seconds.toFixed(1)} s de audio.`);
  for (const j of jobs) {
    const tag = `${j.spec.category}${j.spec.loop ? ', loop' : ''}`;
    console.log(`  ${j.file.padEnd(24)} ${String(j.spec.duration).padStart(4)} s  [${tag}]  ${j.spec.prompt.slice(0, 70)}…`);
  }

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.log('\nFalta ELEVENLABS_API_KEY (en .env.voices). No se llamó a ninguna API.');
    return;
  }
  if (!args.yes) {
    console.log('\nSimulación: añade --yes para generar (consume créditos de ElevenLabs; prueba primero con --only=<id>).');
    return;
  }

  const ffmpeg = hasFfmpeg();
  if (!ffmpeg) console.warn('\n⚠ ffmpeg no encontrado: se guardará el MP3 del proveedor sin masterizar.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sfx-'));
  let totalCost = 0;
  let costKnown = true;
  console.log('\nGenerando con ElevenLabs Sound Effects…');
  try {
    for (const j of jobs) {
      const { audio, cost } = await generateSfx(key, j.spec);
      if (cost === null) costKnown = false;
      else totalCost += cost;
      const outMp3 = path.join(OUT_DIR, j.file);
      if (ffmpeg) {
        const rawPath = path.join(tmpDir, j.file);
        fs.writeFileSync(rawPath, audio);
        masterAudio(rawPath, outMp3, args.ogg ? outMp3.replace(/\.mp3$/, '.ogg') : null, CATEGORY[j.spec.category]);
      } else {
        fs.writeFileSync(outMp3, audio);
      }
      console.log(`  ✓ ${j.file}${cost === null ? '' : ` (${cost} créditos)`}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (costKnown) console.log(`Créditos consumidos: ${totalCost}`);
  writeManifest();
}

main().catch((err) => {
  console.error('Error generando efectos:', err.message || err);
  process.exit(1);
});
