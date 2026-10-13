import fs from 'fs';
import path from 'path';
import https from 'https';

const OUT_DIR = path.resolve('public/assets/voice');
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * Bilingual Neural Voice Bank Specification:
 * 1. ATHENA (F-35 Flight Computer AI - English Technical Female)
 * 2. COMMANDER VORTEX (AWACS Tactical Narrator - Spanish Intense Male/Squadron Lead)
 */
const VOICE_LINES = [
  // ATHENA (F-35 AI Flight Computer - English)
  {
    id: 'athena_online',
    lang: 'en-US',
    text: 'Neural link established. Flight systems online. Engage.'
  },
  {
    id: 'athena_stall',
    lang: 'en-US',
    text: 'Warning. Velocity critical. Increase throttle immediately.'
  },
  {
    id: 'athena_overdrive',
    lang: 'en-US',
    text: 'Afterburner Overdrive engaged. Mach Two.'
  },
  {
    id: 'athena_breach',
    lang: 'en-US',
    text: 'Warning. Hull integrity compromised.'
  },
  {
    id: 'athena_revive',
    lang: 'en-US',
    text: 'Emergency field repair complete. All systems nominal.'
  },
  {
    id: 'athena_eject',
    lang: 'en-US',
    text: 'Critical failure. Eject. Eject.'
  },

  // COMMANDER VORTEX (AWACS Tactical Narrator & Hype - Español)
  {
    id: 'cmd_bogey',
    lang: 'es-MX',
    text: '¡Atención piloto! ¡Misil en el flanco, activa el escudo ahora!'
  },
  {
    id: 'cmd_intercept',
    lang: 'es-MX',
    text: '¡Intercepción perfecta! ¡Escudo al cien por ciento!'
  },
  {
    id: 'cmd_double_streak',
    lang: 'es-MX',
    text: '¡Doble intercepción consecutiva! ¡Defensa impenetrable!'
  },
  {
    id: 'cmd_unstoppable',
    lang: 'es-MX',
    text: '¡Racha imparable! ¡Así se domina el Pacífico!'
  },
  {
    id: 'cmd_close_call',
    lang: 'es-MX',
    text: '¡Uff, eso estuvo a milímetros! ¡Qué reflejos!'
  },
  {
    id: 'cmd_overdrive',
    lang: 'es-MX',
    text: '¡Postquemadores al máximo! ¡Rompiendo la barrera del sonido!'
  },
  {
    id: 'cmd_mayday',
    lang: 'es-MX',
    text: '¡Mayday, entramos en pérdida! ¡Acelera a fondo ahora!'
  },
  {
    id: 'cmd_milestone',
    lang: 'es-MX',
    text: '¡Nuevo récord de combate alcanzado! ¡Mantengan la formación!'
  }
];

function downloadTtsMp3(lang, text, destFile) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=${lang}&q=${encoded}`;

    https
      .get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          }
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${destFile}`));
            return;
          }
          const fileStream = fs.createWriteStream(destFile);
          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });
          fileStream.on('error', reject);
        }
      )
      .on('error', reject);
  });
}

async function main() {
  console.log(`Generating ${VOICE_LINES.length} neural voice lines into ${OUT_DIR}...`);
  for (const line of VOICE_LINES) {
    const outPath = path.join(OUT_DIR, `${line.id}.mp3`);
    await downloadTtsMp3(line.lang, line.text, outPath);
    const stat = fs.statSync(outPath);
    console.log(`  ✓ ${line.id}.mp3 (${stat.size} bytes)`);
  }
  console.log('All neural voice assets generated successfully!');
}

main().catch((err) => {
  console.error('Error generating voice assets:', err);
  process.exit(1);
});
