# Plan: tema visual "Patrulla de Rescate" sin romper el juego

Objetivo: que la imagen cuente la misma historia que el audio (rescate de animalitos) sin
cambiar cómo se juega, cómo se puntúa ni cómo se cobra.

## 1. Qué SÍ se toca y qué NO

| Capa | Archivos | ¿Se toca? |
|---|---|---|
| Motor del juego (física, colisiones, puntaje, pista) | `src/shared/simulation.ts`, `rules.ts`, `math.ts`, `random.ts` | **No** |
| Servidor (salas, pagos, torneo, admin) | `src/server/**` | **No** (solo textos de los avisos rápidos de radio en `roomManager.ts`, que no tienen lógica) |
| Dibujo del juego (canvas) | `src/client/renderer.ts` | Sí |
| Vistas (hangar, HUD, modales) | `index.html`, `src/client/main.ts` (solo textos y el contador de huellitas) | Sí |
| Lógica nueva, aislada y con tests | `src/client/rescueTheme.ts` | Nuevo |

Regla: **cero cambios de reglas de juego**. Los IDs de los elementos HTML y los nombres de las
opciones de personalización (`crimson_jaeger`, etc.) se mantienen, porque el servidor y
`localStorage` los usan; solo cambia el texto que ve el jugador.

## 2. Cómo se trabaja

1. Todo en la rama `feat/tema-rescate`. `main` (lo que despliega Railway) no se toca hasta tu
   aprobación.
2. Cambios por partes, cada una verificable por separado: vehículo y obstáculos → clima y
   animalitos → vistas.
3. Lógica nueva en funciones puras con tests (contador de rescatados, clima por fase).

## 3. Verificación antes de unir a `main`

- [x] `npm test`: 123 tests pasan (los 118 previos + 5 nuevos del tema).
- [x] `npm run build` sin errores.
- [x] Partida en el navegador como **piloto** (hasta chocar → reparación → fin) y como **navegante**, sin errores del juego en consola.
- [x] Modo **SOLO + IA**.
- [ ] Modo **LOCAL 2P** y **DUO ONLINE** con dos navegadores (mismo código de dibujo; falta probarlo a mano).
- [x] Vistas: hangar (Jugar, Vehículo), "Antes de salir", reparación y fin de partida.
- [ ] Vistas: pestañas Torneo y Ranking, inscripción y canje de pase (solo cambiaron textos).
- [x] Celular 375 px: hangar, vehículo y partida (se corrigió el HUD superior, que se salía de pantalla).
- [ ] Formato **9:16** para grabar clips.
- [ ] Rendimiento en un celular real con tormenta (en PC no se notaron bajones).
- [x] Motor y pagos sin cambios: `git diff -- src/shared src/server` solo muestra los 4 textos de radio.

## 4. Cómo volver atrás

- Antes de unir: basta con no unir la rama.
- Después de unir: `git revert <commit>` deshace todo el tema en un solo paso. No hay cambios
  en la base de datos ni migraciones, así que revertir es seguro.

## 5. Etapa 2 (arte profesional, pendiente)

Reemplazar `public/assets/hangar_hero.jpg` (hoy un caza militar) por una ilustración del refugio
de noche con el vehículo de rescate. El juego ya no usa `mecha_unit.jpg`: el vehículo se dibuja
por código y puede reemplazarse luego por un sprite ilustrado del mismo tamaño (56×76).

Pendiente de confirmar con el refugio: valor real de "1 kg de alimento" en dólares (hoy se usa
una estimación en `rescueTheme.ts`) y permiso para usar fotos y nombres de animales reales.
