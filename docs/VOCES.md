# Voces del narrador — Patrulla de Rescate

El narrador habla en español latino neutro con dos personajes:

| Voz | Personaje | Cues |
| --- | --- | --- |
| `guia` | Guía de rescate, femenina, cálida | `athena_*`, `social_food`, `social_shelter`, `social_thanks` |
| `capitan` | Capitán de patrulla, masculino, épico | `cmd_*`, `social_team` |

Los IDs de cue (`athena_*`, `cmd_*`) se conservan por compatibilidad con el código de eventos; el
guion completo vive en `scripts/generate-voices.mjs` (`VOICE_SCRIPT`).

## Archivos

```
public/assets/voice/
  manifest.json          ← lista de variantes por cue (lo genera el script)
  cmd_bogey.mp3          ← variante 1 (ruta histórica)
  cmd_bogey_2.mp3        ← variante 2 …
```

El motor (`src/client/audioEngine.ts`) lee `manifest.json`, precarga todas las variantes y elige una al
azar sin repetir la última. Si un cue no tiene audio, el manifiesto apunta a otro compatible
(`FALLBACK_CUE`) o el cue simplemente no suena; nunca se piden archivos que no existen.

> Estado actual: banco completo (40 variantes, 18 cues) generado con ElevenLabs
> `eleven_multilingual_v2` — guía: *Isabella* (`p18tR9wFA5Ng9WhfWI0o`), capitán: *Brian, latino*
> (`jBlmi27XRORxjPquUeCh`). Todas entre −16,5 y −16,9 LUFS.

## Generar el banco

1. Crea `.env.voices` en la raíz (está en `.gitignore`; no uses el `.env` de producción):

   **ElevenLabs** (voces más expresivas):
   ```
   VOICE_PROVIDER=elevenlabs
   ELEVENLABS_API_KEY=...
   ELEVENLABS_VOICE_GUIA=<voice_id femenina latina>
   ELEVENLABS_VOICE_CAPITAN=<voice_id masculina latina>
   ```

   **Azure Neural** (es-EC / es-MX):
   ```
   VOICE_PROVIDER=azure
   AZURE_SPEECH_KEY=...
   AZURE_SPEECH_REGION=eastus
   # opcionales (por defecto es-EC-AndreaNeural / es-EC-LuisNeural)
   AZURE_VOICE_GUIA=es-MX-DaliaNeural
   AZURE_VOICE_CAPITAN=es-MX-JorgeNeural
   ```

2. Simulación (no llama a la API; muestra guion y caracteres a consumir):
   ```bash
   node scripts/generate-voices.mjs
   ```

3. Generar (consume cuota del proveedor, ~1.700 caracteres para todo el banco):
   ```bash
   node scripts/generate-voices.mjs --yes
   ```
   Opciones: `--only=cmd_bogey,social_food` para regenerar algunos cues, `--ogg` para exportar también
   `.ogg` (Opus), `--manifest-only` para reconstruir `manifest.json` tras borrar o añadir archivos a mano.

4. Escucha en el juego y haz commit de los `.mp3` y `manifest.json`.

### Masterización

Si `ffmpeg` está en el PATH, cada línea se procesa así (`--remaster` repite este paso sobre los MP3 existentes, sin API):

- recorte de silencios al inicio y al final (umbral −45 dB);
- normalización a **−16 LUFS** (medición EBU R128 + ganancia ajustada en hasta 4 pasadas) con limitador de picos;
- MP3 mono 44,1 kHz 96 kbps (y Opus 64 kbps con `--ogg`).

Sin ffmpeg se guarda el MP3 del proveedor tal cual (con aviso).

### Licencia

Revisa que el plan del proveedor permita uso comercial (ElevenLabs: planes de pago; Azure: incluido en
el servicio). No uses el endpoint de Google Translate TTS: no es apto para uso comercial.

## Mezcla en el juego

- **Ducking**: mientras habla el narrador, el motor baja a 35 %, los efectos a 70 % y el bus de música
  (`getMusicBus()`) a 40 %.
- **Modos** (botón `VOZ:` del HUD, se recuerda en `localStorage`): `NATURAL` (voz limpia con un toque de
  ambiente, por defecto), `RADIO` (filtro de radio suave con bip y estática muy baja) y `OFF`.
- **Anti-solapamiento**: una voz normal espera a que no haya otra y a 1,6 s de silencio; una prioritaria
  solo corta a otra que ya lleve 0,9 s sonando; el mismo cue no se repite antes de 4 s.
- **Impacto social**: durante la carrera suena un recordatorio `social_*` cada 40–60 s si el narrador está
  libre, y `social_thanks` después de `athena_eject` (misión fallida).
