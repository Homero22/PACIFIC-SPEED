# Efectos de sonido — Patrulla de Rescate

Los efectos combinan **audio grabado** (generado con ElevenLabs Sound Effects) y **síntesis Web Audio**. Si
un efecto grabado no existe, el motor usa su versión sintetizada, así que el juego nunca queda en silencio
y se puede generar el banco por partes.

| Pieza | Archivo |
| --- | --- |
| Catálogo y generación | `scripts/generate-sfx.mjs` (`SFX_CATALOG`) |
| Masterización compartida con las voces | `scripts/lib/audio-tools.mjs` |
| Carga y variantes en el navegador | `src/client/sfxBank.ts` |
| Mezcla, capas de tensión y lógica por evento | `src/client/audioEngine.ts` |
| Eventos (pan, intensidad, escudos, reparación) | `src/shared/simulation.ts`, `src/shared/types.ts` |
| Archivos generados | `public/assets/sfx/*.mp3` + `manifest.json` |

## Eventos de la simulación

| Evento | Cuándo | Datos extra |
| --- | --- | --- |
| `shield_up` | Se enciende un escudo (pausa mínima 0,35 s) | `pan` del lado |
| `shield_double` | Se encienden los dos escudos (pausa mínima 1 s) | — |
| `shield_deflect` | El escudo bloquea un obstáculo | `pan` |
| `collision_damage` | Choque sin escudo | `pan`, `intensity` = daño acumulado (1 − integridad) |
| `explosion` | Integridad 0 o autodestrucción | `intensity` = 1 |
| `repair_collected` | Celda de reparación (antes disparaba el turbo por error) | `pan` |
| `overdrive_activated` | Celda de turbo | `pan` |
| `ping_deployed`, `revive` | Radar / revivir | — |

## Catálogo

Textos en inglés porque el modelo de efectos responde mejor así. No se nombran juegos, personajes ni marcas:
el doble escudo está *inspirado* en un «clang» de armadura heroico, pero es un sonido propio.

| ID | Uso | Duración | Variantes | Categoría |
| --- | --- | --- | --- | --- |
| `amb_tension_low` | Fondo de tensión base | 20 s (loop) | 1 | ambience |
| `amb_tension_high` | Fondo de tensión alta | 20 s (loop) | 1 | ambience |
| `impact_light` | Choque con integridad > 65 % | 0,8 s | 3 | impact |
| `impact_medium` | Choque con integridad 31–65 % | 1,2 s | 3 | impact |
| `impact_heavy` | Choque con integridad ≤ 30 % | 1,8 s | 3 | impact |
| `dmg_sparks` | Capa de chispas (daño ≥ 35 %) | 10 s (loop) | 1 | damage_loop |
| `dmg_critical` | Estructura crujiendo (daño ≥ 70 %) | 10 s (loop) | 1 | damage_loop |
| `shield_double` | Doble escudo | 1,4 s | 3 | shield |
| `shield_up` | Un escudo | 0,7 s | 2 | shield |
| `shield_deflect` | Bloqueo con escudo | 0,7 s | 3 | shield |
| `destroy_metal` | Destrucción de la nave | 4 s | 2 | impact |
| `repair` | Reparación / revivir | 1,2 s | 2 | pickup |
| `turbo` | Turbo | 1,4 s | 2 | pickup |
| `radar_ping` | Radar del navegante | 0,8 s | 2 | ui |
| `reward_rescue` | Récord y frases sociales (campanita + ladrido feliz) | 1,5 s | 2 | pickup |

Masterización por categoría (ffmpeg, mismo método EBU R128 + limitador que las voces):

| Categoría | LUFS | Canales | Recorte de silencios |
| --- | --- | --- | --- |
| impact | −14 | estéreo | sí |
| shield | −15 | estéreo | sí |
| pickup | −16 | estéreo | sí |
| ui | −20 | mono | sí |
| damage_loop | −22 | estéreo | no (rompería el loop) |
| ambience | −24 | estéreo | no |

## Generar

Usa la misma `ELEVENLABS_API_KEY` de `.env.voices` (ver [VOCES.md](VOCES.md)).

```bash
node scripts/generate-sfx.mjs
```

```bash
node scripts/generate-sfx.mjs --yes --only=shield_double
```

> Estado actual: banco completo generado (15 efectos, 31 archivos, 969 créditos en total). Todas las
> categorías quedan a ±1 LU de su objetivo y los 4 loops empalman sin silencio ni salto de nivel.

Sin `--yes` es una simulación que no llama a la API. Costo medido: **~10 créditos por segundo** de audio
(`shield_double`, 3 × 1,4 s = 42 créditos). El catálogo completo son 31 archivos y 96,9 s, unos
**970 créditos**. Otras opciones: `--remaster` (re-masteriza sin API), `--manifest-only`, `--ogg`.

## Mezcla en el juego

- **Choque envolvente**: muestra según gravedad (`impact_light/medium/heavy`), copia retardada 14 ms al lado
  opuesto (efecto Haas), eco proporcional al daño, golpe grave sintetizado y una caída breve de motor y fondos
  (150–250 ms) para que el golpe se sienta. Suena del lado del obstáculo.
- **Intensidad por daño** (integridad que queda):

  | Integridad | Choque | Capas | Fondo | Motor |
  | --- | --- | --- | --- | --- |
  | 100–66 % | `impact_light` | — | sobre todo `amb_tension_low` | normal |
  | 65–31 % | `impact_medium` | `dmg_sparks` | mezcla low/high | más apagado |
  | 30–1 % | `impact_heavy` | `dmg_sparks` + `dmg_critical` | sobre todo `amb_tension_high` | muy apagado |
  | 0 % | `impact_heavy` → `destroy_metal` (+120 ms) | silencio de 1,5 s | se corta | — |

  La tensión del fondo es `max(velocidad × 0,6, daño)`, con transiciones de ~2 s.
- **Buses**: efectos (70 % bajo la voz), fondos (50 % bajo la voz), motor (35 %), música (40 %).
- **Variedad**: variante al azar sin repetir la anterior y ±3 % de tono.
- **Recompensa**: `reward_rescue` acompaña al récord y a las frases sociales del narrador.

## Probar

En local, la consola del navegador expone el motor:

```js
__audio.getLoadedSfx()
__audio.playSfx('shield_double', { wide: true })
__audio.triggerSoundEffect('collision_damage', -0.6, 0.8)
```

Los tests de `src/shared/simulation.sound.test.ts` comprueban los eventos nuevos.
