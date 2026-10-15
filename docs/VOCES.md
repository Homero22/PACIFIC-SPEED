# Voces del narrador — Patrulla de Rescate

El narrador habla en español latino neutro con dos personajes:

| Voz | Personaje | ElevenLabs | Cues |
| --- | --- | --- | --- |
| `guia` | Guía de rescate, alegre y cálida | *Lulu – Adorable, Bright & Playful* (`CPv3Zr3CQCqE4ZzuCgBP`), latina | `athena_*`, `social_food`, `social_shelter`, `social_thanks` |
| `capitan` | Capitán de patrulla, épico | *Comandante perruno* (`tBmHCnOxpyPXXVK6IJrd`), voz clonada | `cmd_*`, `social_team` |

Los IDs de cue (`athena_*`, `cmd_*`) se conservan por compatibilidad con el código de eventos; el
guion completo vive en `scripts/generate-voices.mjs` (`VOICE_SCRIPT`) y se lista abajo en
[Textos del narrador](#textos-del-narrador).

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
> `eleven_multilingual_v2` con las voces de la tabla. Todas entre −16,4 y −16,8 LUFS.

## Generar el banco

1. Crea `.env.voices` en la raíz (está en `.gitignore`; no uses el `.env` de producción):

   **ElevenLabs** (voces más expresivas):
   ```
   VOICE_PROVIDER=elevenlabs
   ELEVENLABS_API_KEY=...
   ELEVENLABS_VOICE_GUIA=<voice_id femenina latina>
   ELEVENLABS_VOICE_CAPITAN=<voice_id masculina latina>
   # opcionales: ajustes por voz
   ELEVENLABS_STABILITY_CAPITAN=0.85
   ELEVENLABS_STYLE_CAPITAN=0
   ```

   Por defecto la guía usa estabilidad 0,45 y estilo 0,35 (expresiva), y el capitán estabilidad 0,85 y
   estilo 0. Con estilo alto, la voz clonada del capitán improvisaba sonidos de más: un «¡Turbo!» de 4 s.
   Si cambias de voz y las frases salen mucho más largas de lo esperado, sube la estabilidad.

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

3. Generar (consume cuota del proveedor, ~1.260 caracteres para todo el banco):
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

## Textos del narrador

Generado desde `VOICE_SCRIPT` (`scripts/generate-voices.mjs`), que es la fuente de verdad: si cambias un
texto ahí, regenera ese cue con `--only` y actualiza esta tabla.

### Guía — Lulu

| Momento | Archivo | Texto |
| --- | --- | --- |
| Inicio de misión | `athena_online` | ¡Patrulla de rescate en marcha! Los peluditos nos esperan. |
|  | `athena_online_2` | ¡Motores listos, equipo! Hoy salimos a rescatar. |
|  | `athena_online_3` | ¡Arrancamos! Cada carrera cuenta para el refugio. |
| Velocidad crítica | `athena_stall` | ¡Cuidado, vamos muy lentos! Acelera, que nos necesitan. |
|  | `athena_stall_2` | ¡Perdemos velocidad! Dale más fuerza, compañero. |
| Turbo | `athena_overdrive` | ¡Turbo de rescate activado! |
|  | `athena_overdrive_2` | ¡Turbo al máximo! ¡Vamos volando! |
| Impacto | `athena_breach` | ¡Recibimos un golpe! Tranquilos, seguimos en pie. |
|  | `athena_breach_2` | ¡Auch! Daño en el vehículo, mantén el rumbo. |
| Reparación | `athena_revive` | ¡Reparación completa! De vuelta al rescate. |
|  | `athena_revive_2` | ¡Listo, como nuevo! Seguimos adelante. |
| Misión fallida | `athena_eject` | Misión terminada… pero cada intento suma para el refugio. ¡Otra vez! |
|  | `athena_eject_2` | Nos detuvimos aquí, equipo. ¡Gracias por correr por ellos! |
|  | `athena_eject_3` | Fin del recorrido. Respira, y volvemos a intentarlo. |
| Social: comida | `social_food` | ¡Cada kilómetro suma comida para el refugio! |
|  | `social_food_2` | ¡Sigue corriendo! Cada punto es un platito lleno. |
| Social: refugio | `social_shelter` | Parte de tu inscripción va directo al refugio. ¡Gracias! |
|  | `social_shelter_2` | Hoy tu carrera ayuda a darles un hogar calientito. |
| Social: gracias | `social_thanks` | De parte de todos los peluditos: ¡gracias, héroe! |
|  | `social_thanks_2` | Ellos no lo saben, pero hoy corriste por ellos. ¡Gracias! |

### Capitán — Comandante perruno

Frases de 1–4 palabras (~0,6–1,5 s) para no frenar la acción.

| Momento | Archivo | Texto |
| --- | --- | --- |
| Alerta de obstáculo | `cmd_bogey` | ¡Obstáculo! ¡Escudo! |
|  | `cmd_bogey_2` | ¡Cuidado, escudo arriba! |
| Escudo perfecto | `cmd_intercept` | ¡Perfecto! |
|  | `cmd_intercept_2` | ¡Bloqueado! |
|  | `cmd_intercept_3` | ¡Impecable! |
| Racha x2 | `cmd_double_streak` | ¡Doble defensa! |
|  | `cmd_double_streak_2` | ¡Dos de dos! |
| Racha imparable | `cmd_unstoppable` | ¡Imparable! |
|  | `cmd_unstoppable_2` | ¡Nadie los detiene! |
| Casi-choque | `cmd_close_call` | ¡Por un pelito! |
|  | `cmd_close_call_2` | ¡Qué reflejos! |
|  | `cmd_close_call_3` | ¡Casi! |
| Turbo | `cmd_overdrive` | ¡Turbo! |
|  | `cmd_overdrive_2` | ¡A fondo! |
| Peligro | `cmd_mayday` | ¡Peligro! ¡Acelera! |
|  | `cmd_mayday_2` | ¡Dale todo! |
| Récord | `cmd_milestone` | ¡Nuevo récord! |
|  | `cmd_milestone_2` | ¡Récord superado! |
| Social: equipo | `social_team` | ¡Por los peluditos! |
|  | `social_team_2` | ¡Nadie se queda atrás! |

## Mezcla en el juego

- **Ducking**: mientras habla el narrador, el motor baja a 35 %, los efectos a 70 % y el bus de música
  (`getMusicBus()`) a 40 %.
- **Modos** (botón `VOZ:` del HUD, se recuerda en `localStorage`): `NATURAL` (voz limpia con un toque de
  ambiente, por defecto), `RADIO` (filtro de radio suave con bip y estática muy baja) y `OFF`.
- **Anti-solapamiento**: una voz normal espera a que no haya otra y a 1,6 s de silencio; una prioritaria
  solo corta a otra que ya lleve 0,9 s sonando; el mismo cue no se repite antes de 4 s.
- **Impacto social**: durante la carrera suena un recordatorio `social_*` cada 40–60 s si el narrador está
  libre, y `social_thanks` después de `athena_eject` (misión fallida).
