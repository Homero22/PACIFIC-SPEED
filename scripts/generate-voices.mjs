#!/usr/bin/env node
/**
 * PACIFIC SPEED — Banco de voces "Patrulla de Rescate".
 *
 * Genera las voces del narrador en español latino neutro con un proveedor TTS
 * profesional (ElevenLabs o Azure Neural), las normaliza a −16 LUFS con ffmpeg
 * (recortando silencios) y escribe public/assets/voice/manifest.json, que el
 * motor de audio usa para elegir variantes al azar.
 *
 * Uso (ver docs/VOCES.md):
 *   node scripts/generate-voices.mjs                 → simulación: muestra guion y costo, no llama a ninguna API
 *   node scripts/generate-voices.mjs --yes           → genera todas las variantes (API de pago)
 *   node scripts/generate-voices.mjs --yes --only=cmd_bogey,social_food
 *   node scripts/generate-voices.mjs --yes --ogg     → además exporta .ogg (Opus)
 *   node scripts/generate-voices.mjs --manifest-only → reconstruye manifest.json con los archivos existentes
 *   node scripts/generate-voices.mjs --remaster      → re-masteriza los MP3 existentes (sin API)
 *
 * Variables de entorno (en el entorno o en .env.voices — nunca en el repo):
 *   VOICE_PROVIDER          elevenlabs | azure
 *   ELEVENLABS_API_KEY      clave de ElevenLabs
 *   ELEVENLABS_VOICE_GUIA   voice_id de la voz femenina (guía de rescate)
 *   ELEVENLABS_VOICE_CAPITAN voice_id de la voz masculina (capitán de patrulla)
 *   ELEVENLABS_MODEL        opcional, por defecto eleven_multilingual_v2
 *   ELEVENLABS_STABILITY_GUIA / _CAPITAN, ELEVENLABS_STYLE_GUIA / _CAPITAN  opcionales (ajustes por voz)
 *   AZURE_SPEECH_KEY        clave de Azure Speech
 *   AZURE_SPEECH_REGION     región, p. ej. eastus
 *   AZURE_VOICE_GUIA        opcional, por defecto es-EC-AndreaNeural
 *   AZURE_VOICE_CAPITAN     opcional, por defecto es-EC-LuisNeural
 *
 * Nota: NO se lee el .env del proyecto (apunta a producción); solo .env.voices.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT, fileNameFor, hasFfmpeg, loadVoicesEnv, masterAudio } from './lib/audio-tools.mjs';
const OUT_DIR = path.join(ROOT, 'public/assets/voice');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');

/**
 * Guion. Cada cue conserva su ID histórico (el código de eventos no cambia);
 * la variante 1 se guarda como `${id}.mp3` y las demás como `${id}_N.mp3`.
 * guia = voz femenina cálida (sistema/estado); capitan = voz masculina épica (acción/hype).
 * Las frases del capitán son de 1–4 palabras: su voz es pausada y deben durar ~1–2 s.
 */
export const VOICE_SCRIPT = {
  // Inicio de misión
  athena_online: {
    voice: 'guia',
    lines: [
      '¡Patrulla de rescate en marcha! Los peluditos nos esperan.',
      '¡Motores listos, equipo! Hoy salimos a rescatar.',
      '¡Arrancamos! Cada carrera cuenta para el refugio.'
    ]
  },
  // Velocidad crítica
  athena_stall: {
    voice: 'guia',
    lines: [
      '¡Cuidado, vamos muy lentos! Acelera, que nos necesitan.',
      '¡Perdemos velocidad! Dale más fuerza, compañero.'
    ]
  },
  // Turbo activado
  athena_overdrive: {
    voice: 'guia',
    lines: ['¡Turbo de rescate activado!', '¡Turbo al máximo! ¡Vamos volando!']
  },
  // Impacto / daño
  athena_breach: {
    voice: 'guia',
    lines: [
      '¡Recibimos un golpe! Tranquilos, seguimos en pie.',
      '¡Auch! Daño en el vehículo, mantén el rumbo.'
    ]
  },
  // Reparación
  athena_revive: {
    voice: 'guia',
    lines: [
      '¡Reparación completa! De vuelta al rescate.',
      '¡Listo, como nuevo! Seguimos adelante.'
    ]
  },
  // Misión fallida
  athena_eject: {
    voice: 'guia',
    lines: [
      'Misión terminada… pero cada intento suma para el refugio. ¡Otra vez!',
      'Nos detuvimos aquí, equipo. ¡Gracias por correr por ellos!',
      'Fin del recorrido. Respira, y volvemos a intentarlo.'
    ]
  },
  // Alerta de obstáculo
  cmd_bogey: {
    voice: 'capitan',
    lines: ['¡Obstáculo! ¡Escudo!', '¡Cuidado, escudo arriba!']
  },
  // Escudo perfecto
  cmd_intercept: {
    voice: 'capitan',
    lines: ['¡Perfecto!', '¡Bloqueado!', '¡Impecable!']
  },
  // Racha x2
  cmd_double_streak: {
    voice: 'capitan',
    lines: ['¡Doble defensa!', '¡Dos de dos!']
  },
  // Racha imparable
  cmd_unstoppable: {
    voice: 'capitan',
    lines: ['¡Imparable!', '¡Nadie los detiene!']
  },
  // Casi-choque
  cmd_close_call: {
    voice: 'capitan',
    lines: ['¡Por un pelito!', '¡Qué reflejos!', '¡Casi!']
  },
  // Turbo (voz del capitán)
  cmd_overdrive: {
    voice: 'capitan',
    lines: ['¡Turbo!', '¡A fondo!']
  },
  // Peligro
  cmd_mayday: {
    voice: 'capitan',
    lines: ['¡Peligro! ¡Acelera!', '¡Dale todo!']
  },
  // Récord
  cmd_milestone: {
    voice: 'capitan',
    lines: ['¡Nuevo récord!', '¡Récord superado!']
  },
  // ——— Impacto social (nuevos) ———
  social_food: {
    voice: 'guia',
    lines: [
      '¡Cada kilómetro suma comida para el refugio!',
      '¡Sigue corriendo! Cada punto es un platito lleno.'
    ]
  },
  social_shelter: {
    voice: 'guia',
    lines: [
      'Parte de tu inscripción va directo al refugio. ¡Gracias!',
      'Hoy tu carrera ayuda a darles un hogar calientito.'
    ]
  },
  social_team: {
    voice: 'capitan',
    lines: ['¡Por los peluditos!', '¡Nadie se queda atrás!']
  },
  social_thanks: {
    voice: 'guia',
    lines: [
      'De parte de todos los peluditos: ¡gracias, héroe!',
      'Ellos no lo saben, pero hoy corriste por ellos. ¡Gracias!'
    ]
  }
};

/** Si un cue aún no tiene audio, el manifiesto apunta a uno compatible. */
const FALLBACK_CUE = {
  athena_stall: 'cmd_mayday',
  athena_overdrive: 'cmd_overdrive',
  athena_breach: 'cmd_bogey'
};

// ————————————————————————————————————————————————————————————————

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
  return args;
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function makeProvider() {
  const name = (process.env.VOICE_PROVIDER || '').toLowerCase();

  if (name === 'elevenlabs') {
    const key = process.env.ELEVENLABS_API_KEY;
    const voices = { guia: process.env.ELEVENLABS_VOICE_GUIA, capitan: process.env.ELEVENLABS_VOICE_CAPITAN };
    // Ajustes por voz. Las voces clonadas con estilo alto improvisan sonidos de más (un "¡Turbo!" de 4 s),
    // por eso el capitán usa estabilidad alta y estilo 0. Se pueden sobrescribir con ELEVENLABS_STABILITY_<VOZ>
    // y ELEVENLABS_STYLE_<VOZ> (p. ej. ELEVENLABS_STABILITY_CAPITAN=0.7).
    const defaults = {
      guia: { stability: 0.45, similarity_boost: 0.8, style: 0.35 },
      capitan: { stability: 0.85, similarity_boost: 0.6, style: 0 }
    };
    const settingsFor = (voice) => {
      const env = (name) => process.env[`ELEVENLABS_${name}_${voice.toUpperCase()}`];
      const d = defaults[voice];
      return {
        stability: Number(env('STABILITY') ?? d.stability),
        similarity_boost: d.similarity_boost,
        style: Number(env('STYLE') ?? d.style),
        use_speaker_boost: true
      };
    };
    const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
    const missing = [!key && 'ELEVENLABS_API_KEY', !voices.guia && 'ELEVENLABS_VOICE_GUIA', !voices.capitan && 'ELEVENLABS_VOICE_CAPITAN'].filter(Boolean);
    return {
      name: `ElevenLabs (${model})`,
      missing,
      async synth(text, voice) {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voices[voice]}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
            body: JSON.stringify({
              text,
              model_id: model,
              language_code: 'es',
              voice_settings: settingsFor(voice)
            })
          }
        );
        if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return Buffer.from(await res.arrayBuffer());
      }
    };
  }

  if (name === 'azure') {
    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION;
    const voices = {
      guia: process.env.AZURE_VOICE_GUIA || 'es-EC-AndreaNeural',
      capitan: process.env.AZURE_VOICE_CAPITAN || 'es-EC-LuisNeural'
    };
    const missing = [!key && 'AZURE_SPEECH_KEY', !region && 'AZURE_SPEECH_REGION'].filter(Boolean);
    return {
      name: `Azure Neural (${voices.guia} / ${voices.capitan})`,
      missing,
      async synth(text, voice) {
        const voiceName = voices[voice];
        const locale = voiceName.split('-').slice(0, 2).join('-');
        // Tono cálido-épico: ligeramente más rápido y animado.
        const ssml =
          `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
          `<voice name="${voiceName}"><prosody rate="+6%" pitch="+2%">${escapeXml(text)}</prosody></voice></speak>`;
        const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
            'User-Agent': 'pacific-speed-voices'
          },
          body: ssml
        });
        if (!res.ok) throw new Error(`Azure HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return Buffer.from(await res.arrayBuffer());
      }
    };
  }

  return { name: null, missing: ['VOICE_PROVIDER (elevenlabs | azure)'] };
}

/** Vuelve a masterizar los MP3 existentes sin llamar a la API. */
function remasterExisting(only, ogg) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-remaster-'));
  try {
    for (const [cueId, spec] of Object.entries(VOICE_SCRIPT)) {
      if (only && !only.has(cueId)) continue;
      spec.lines.forEach((_, i) => {
        const file = fileNameFor(cueId, i);
        const outMp3 = path.join(OUT_DIR, file);
        if (!fs.existsSync(outMp3)) return;
        const src = path.join(tmpDir, file);
        fs.copyFileSync(outMp3, src);
        masterAudio(src, outMp3, ogg ? outMp3.replace(/\.mp3$/, '.ogg') : null);
        console.log(`  ✓ ${file}`);
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** manifest.json: { cues: { cueId: ["archivo.mp3", ...] } } con solo archivos existentes. */
function writeManifest() {
  const existing = new Set(fs.readdirSync(OUT_DIR));
  const cues = {};
  for (const [cueId, spec] of Object.entries(VOICE_SCRIPT)) {
    cues[cueId] = spec.lines.map((_, i) => fileNameFor(cueId, i)).filter((f) => existing.has(f));
  }
  for (const [cueId, fallbackId] of Object.entries(FALLBACK_CUE)) {
    if (cues[cueId].length === 0) cues[cueId] = [...cues[fallbackId]];
  }
  const manifest = { version: 1, generatedAt: new Date().toISOString(), cues };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  const total = Object.values(cues).reduce((n, list) => n + list.length, 0);
  const empty = Object.keys(cues).filter((k) => cues[k].length === 0);
  console.log(`manifest.json: ${total} archivos en ${Object.keys(cues).length} cues${empty.length ? ` (sin audio: ${empty.join(', ')})` : ''}`);
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
  for (const [cueId, spec] of Object.entries(VOICE_SCRIPT)) {
    if (args.only && !args.only.has(cueId)) continue;
    spec.lines.forEach((text, i) => jobs.push({ cueId, voice: spec.voice, text, file: fileNameFor(cueId, i) }));
  }
  const chars = jobs.reduce((n, j) => n + j.text.length, 0);
  const provider = makeProvider();

  console.log(`Guion: ${jobs.length} líneas, ${chars} caracteres.`);
  for (const j of jobs) console.log(`  [${j.voice.padEnd(7)}] ${j.file.padEnd(26)} ${j.text}`);

  if (provider.missing.length) {
    console.log(`\nFaltan variables: ${provider.missing.join(', ')}. Ver docs/VOCES.md.`);
    console.log('No se llamó a ninguna API.');
    return;
  }
  if (!args.yes) {
    console.log(`\nProveedor: ${provider.name}. Simulación: añade --yes para generar (consume ~${chars} caracteres de cuota).`);
    return;
  }

  const ffmpeg = hasFfmpeg();
  if (!ffmpeg) console.warn('\n⚠ ffmpeg no encontrado: se guardará el MP3 del proveedor sin normalizar ni recortar.');
  if (args.ogg && !ffmpeg) console.warn('⚠ --ogg requiere ffmpeg; se omite.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-voices-'));
  console.log(`\nGenerando con ${provider.name}…`);
  try {
    for (const j of jobs) {
      const raw = await provider.synth(j.text, j.voice);
      const outMp3 = path.join(OUT_DIR, j.file);
      if (ffmpeg) {
        const rawPath = path.join(tmpDir, j.file);
        fs.writeFileSync(rawPath, raw);
        masterAudio(rawPath, outMp3, args.ogg ? outMp3.replace(/\.mp3$/, '.ogg') : null);
      } else {
        fs.writeFileSync(outMp3, raw);
      }
      console.log(`  ✓ ${j.file} (${fs.statSync(outMp3).size} bytes)`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  writeManifest();
}

main().catch((err) => {
  console.error('Error generando voces:', err.message || err);
  process.exit(1);
});
