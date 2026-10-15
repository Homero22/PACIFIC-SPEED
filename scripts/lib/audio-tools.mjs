/**
 * Utilidades compartidas por generate-voices.mjs y generate-sfx.mjs:
 * carga de .env.voices, detección de ffmpeg y masterización (recorte + normalización LUFS).
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Carga .env.voices (claves TTS/SFX). Nunca lee el .env del proyecto, que apunta a producción. */
export function loadVoicesEnv() {
  const envFile = path.join(ROOT, '.env.voices');
  if (!fs.existsSync(envFile)) return;
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env) && value) process.env[key] = value;
  }
}

/** Variante 1 = `${id}.ext` (ruta histórica), variante N = `${id}_N.ext`. */
export function fileNameFor(id, variantIdx, ext = 'mp3') {
  return variantIdx === 0 ? `${id}.${ext}` : `${id}_${variantIdx + 1}.${ext}`;
}

export function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
  return r.status === 0;
}

const TRIM =
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.04,' +
  'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse';

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg falló: ${r.stderr}`);
}

export function measureLufs(file, preFilter) {
  const af = preFilter ? `${preFilter},ebur128` : 'ebur128';
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', af, '-f', 'null', '-'], {
    encoding: 'utf8'
  });
  const measured = /I:\s+(-?[\d.]+) LUFS/.exec((probe.stderr || '').split('Summary:').pop());
  return measured ? Number(measured[1]) : null;
}

/**
 * Recorta silencios (opcional) y normaliza a `targetLufs` con ganancia + limitador. Como el limitador
 * baja la sonoridad de los transitorios, se mide el resultado y se corrige la ganancia (hasta 4 pasadas);
 * loudnorm es impreciso en clips de 1–2 s.
 *
 * @param {object} o
 * @param {number} [o.targetLufs=-16]
 * @param {boolean} [o.trim=true]   false para loops (recortar rompería el empalme)
 * @param {number} [o.channels=1]   1 = mono (voces), 2 = estéreo (efectos envolventes y ambientes)
 * @param {string} [o.bitrate='96k']
 */
export function masterAudio(rawPath, outMp3, outOgg, o = {}) {
  const { targetLufs = -16, trim = true, channels = 1, bitrate = '96k' } = o;
  // Limitador (0.75 ≈ −2,5 dBFS de muestra) para que el pico real del MP3 quede ≤ −1,5 dBTP
  const limiter = 'alimiter=limit=0.75:attack=2:release=40:level=false';
  const prepared = rawPath.replace(/\.[^.]+$/, '') + '.prep.wav';
  ffmpeg(['-i', rawPath, ...(trim ? ['-af', TRIM] : []), '-ar', '44100', '-ac', String(channels), prepared]);

  const initial = measureLufs(prepared);
  let gainDb = initial === null ? 0 : targetLufs - initial;
  for (let pass = 0; pass < 4; pass++) {
    gainDb = Math.max(-20, Math.min(30, gainDb));
    const result = measureLufs(prepared, `volume=${gainDb.toFixed(2)}dB,${limiter}`);
    if (result === null || Math.abs(targetLufs - result) < 0.5) break;
    gainDb += targetLufs - result;
  }

  const filter = `volume=${gainDb.toFixed(2)}dB,${limiter}`;
  const ch = String(channels);
  ffmpeg(['-i', prepared, '-af', filter, '-ar', '44100', '-ac', ch, '-c:a', 'libmp3lame', '-b:a', bitrate, outMp3]);
  if (outOgg) ffmpeg(['-i', prepared, '-af', filter, '-ar', '48000', '-ac', ch, '-c:a', 'libopus', '-b:a', '64k', outOgg]);
  fs.rmSync(prepared, { force: true });
}
