# Documentación Técnica: Creación de Jugadores y Persistencia de Partidas

Esta guía detalla de manera exhaustiva el ciclo de vida de los jugadores en el Hangar y cómo se procesa y persiste la información de cada partida en **PACIFIC SPEED: OVERDRIVE**.

---

## 1. Ciclo de Vida y Creación de Jugadores en el Hangar

El jugador se inicializa en el frontend ([main.ts](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/client/main.ts)) y negocia su rol en el backend ([roomManager.ts](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/server/roomManager.ts)).

### A. Inicialización de Identidad en el Navegador (`Cliente`)

Cuando un usuario abre el juego, el constructor de `PacificSpeedClientApp` ejecuta los siguientes pasos:

1. **ID Único de Sesión (`playerId`)** ([main.ts#L64-L67](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/client/main.ts#L64-L67)):
   ```typescript
   this.playerId =
     sessionStorage.getItem('ps_player_id') ||
     `PILOT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
   sessionStorage.setItem('ps_player_id', this.playerId);
   ```
   - **Por qué `sessionStorage`**: Permite que si el jugador recarga la pestaña (`F5` o `Ctrl+F5`), mantenga exactamente el mismo identificador dentro de la sala WebSocket. Si abre una segunda pestaña para probar el juego en solitario, esa nueva pestaña tendrá su propio `playerId` independiente.

2. **Callsign / Nombre de Piloto (`pilotName`)** ([main.ts#L69-L72](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/client/main.ts#L69-L72)):
   ```typescript
   this.pilotName =
     localStorage.getItem('ps_pilot_name') ||
     `RAPTOR_${Math.floor(10 + Math.random() * 89)}`;
   ```
   - Se guarda en `localStorage` para que el nombre persista en futuras visitas del usuario.
   - El jugador puede editarlo en cualquier momento desde el input del Hangar (`#pilot-name-input`). Al cambiarlo, se sanitiza a mayúsculas y un máximo de 16 caracteres:
     ```typescript
     this.pilotName = (nameInput.value || 'PILOT').toUpperCase().slice(0, 16);
     localStorage.setItem('ps_pilot_name', this.pilotName);
     ```

3. **Carga y Personalización Cosmética (`cosmetics`)** ([main.ts#L32-L80](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/client/main.ts#L32-L80)):
   ```typescript
   export interface CosmeticLoadout {
     paintJob: 'crimson_jaeger' | 'cyber_gold' | 'phantom_stealth';
     neonTrail: 'plasma_cyan' | 'overdrive_magenta' | 'solar_flare';
     hudTheme: 'tactical_amber' | 'neural_green' | 'abyssal_violet';
   }
   ```
   - Se recupera de `localStorage.getItem('ps_cosmetics')`.
   - Modifica en tiempo real el tema CSS (`data-hud-theme`) y las paletas del renderizador Canvas.
   - Si se cambia en el Hangar, se guarda localmente y se transmite a los demás pilotos de la sala con el mensaje WebSocket `{ type: 'update_cosmetics', cosmetics }`.

4. **Resolución de Código de Sala (`roomCode`)** ([main.ts#L82-L90](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/client/main.ts#L82-L90)):
   - Lee el parámetro `?room=` de la URL. Si no existe, genera uno aleatorio (ej. `NEURAL-8F2`) y actualiza la URL con `window.history.replaceState` sin recargar la página.

---

### B. Negociación y Asignación de Rol en el Servidor (`Servidor WebSocket`)

Cuando el cliente abre conexión WebSocket, envía el paquete:
```typescript
{
  type: 'join_room',
  room_code: 'NEURAL-01',
  player_id: 'PILOT-9X2A',
  name: 'RAPTOR_44',
  preferred_role: 'driver', // o 'navigator'
  cosmetics: { ... }
}
```

En [roomManager.ts#L99-L148](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/server/roomManager.ts#L99-L148), el servidor ejecuta la lógica de auto-asignación:

1. **Inspección de Asientos Ocupados**:
   - Revisa si en la sala ya existe otro jugador con el rol de `driver` o `navigator`.
2. **Resolución de Conflictos de Asiento**:
   - Si el jugador solicitó `driver` pero el asiento ya está ocupado y el asiento de `navigator` está libre, el servidor le asigna automáticamente `navigator`.
   - Si el jugador solicitó `navigator` pero ya está ocupado, se le asigna `driver`.
3. **Instanciación del Jugador Conectado**:
   ```typescript
   const playerInfo: ConnectedPlayer = {
     player_id: playerId,
     name: (name || 'PILOT').slice(0, 16).toUpperCase(),
     role: assignedRole,
     ready: true,
     cosmetics,
     ws
   };
   room.players.set(playerId, playerInfo);
   ```
4. **Respuesta y Notificación**:
   - Envía `room_joined` al nuevo jugador con el rol final asignado.
   - Emite `lobby_update` a todos los jugadores de la sala para actualizar la lista de tripulación visual en el Hangar.

### C. Cambio de Rol en Caliente (`switchRole`)
Si un jugador hace clic en "PILOT B // NAVIGATOR" y el otro jugador ya tenía ese rol, el servidor ejecuta un intercambio atómico ([roomManager.ts#L170-L186](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/server/roomManager.ts#L170-L186)): el otro jugador pasa automáticamente a ser `driver`, y el solicitante pasa a ser `navigator`, sincronizando a ambos instantáneamente.

### D. Soporte de Asiento Vacío con Co-Piloto IA
Si en una sala online solo hay 1 jugador humano y pulsa **LAUNCH**, la simulación autoritativa del servidor ejecuta:
```typescript
if (!hasDriver) room.simulation.updateBotCoPilot('driver');
if (!hasNavigator) room.simulation.updateBotCoPilot('navigator');
```
La IA asume el asiento faltante hasta que un segundo humano se una con el link de la sala.

---

## 2. ¿Cómo se guardan las partidas?

El sistema gestiona la información de partidas en dos niveles: **en el navegador del cliente** y **en el servidor central**.

### A. Lo que se guarda en el Navegador del Jugador (`Web Storage`)
| Clave | Almacenamiento | Propósito |
| :--- | :--- | :--- |
| `ps_player_id` | `sessionStorage` | ID único de sesión activa (evita desconexiones por recargar). |
| `ps_pilot_name` | `localStorage` | Nombre elegido por el jugador (permanece entre visitas). |
| `ps_cosmetics` | `localStorage` | Selección de pintura del Mecha, estela de neón y tema de HUD. |

---

### B. Registro y Guardado de Resultados de Partida (`Leaderboard`)

El guardado del resultado ocurre automáticamente en el momento exacto en que termina una partida (`status === 'gameover'`).

#### 1. Estructura de Datos de una Partida ([types.ts#L198-L208](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/shared/types.ts#L198-L208)):
```typescript
export interface LeaderboardEntry {
  id: string;               // ID único autogenerado (ej: 'lb-1791868000-a4f1')
  room_code: string;        // Código de la sala o 'LOCAL-2P' / 'SOLO-AI'
  driver_name: string;      // Nombre del Piloto A (o 'AI_DRIVER')
  navigator_name: string;   // Nombre del Piloto B (o 'AI_NAVIGATOR')
  total_score: number;      // Puntuación calculada según las fórmulas de juego
  distance_traveled: number;// Metros recorridos
  survival_time: number;    // Segundos en vuelo
  region: string;           // Nodo regional ('PACIFIC-NET' o 'LOCAL-SIM')
  created_at: string;       // Fecha y hora ISO 8601
}
```

#### 2. Fórmula de Puntuación Guardada ([rules.ts#L70-L80](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/shared/rules.ts#L70-L80)):
$$\text{total\_score} = (\text{distancia} \times 10) + (\text{tiempo} \times 50) \times (\text{is\_overdrive} \text{ ? } 2.0 : 1.0)$$

#### 3. Flujo en Modo Online WebSocket ([roomManager.ts#L350-L370](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/server/roomManager.ts#L350-L370)):
1. Cuando la integridad llega a `0` (y ya se usó o rechazó el anuncio de revivir), `simulation.getStatus()` pasa a `'gameover'`.
2. El servidor detecta la condición `status === 'gameover' && !room.scoreRecorded`.
3. Ejecuta `recordRoomScore()`:
   - Extrae el nombre del Driver y del Navigator.
   - Crea un `LeaderboardEntry` y lo añade a `this.leaderboard`.
   - Ordena la lista por `total_score` descendente y retiene los mejores registros.
   - Envía el mensaje WebSocket `{ type: 'leaderboard_update', entries }` a los jugadores.

#### 4. Flujo en Modo Local / Práctica ([main.ts#L508-L536](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/client/main.ts#L508-L536)):
Cuando se juega en modo local (sin sala WebSocket activa), al terminar la partida el cliente envía un POST HTTP a la API REST del servidor:
```typescript
fetch('/api/leaderboard', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    room_code: 'LOCAL-2P',
    driver_name: this.pilotName,
    navigator_name: 'AWACS_AI',
    total_score: ws.total_score,
    distance_traveled: ws.distance_traveled,
    survival_time: ws.survival_time,
    region: 'LOCAL-SIM'
  })
});
```

---

### C. Endpoints REST Disponibles en el Servidor ([index.ts#L25-L48](file:///c:/Users/Usuario-PC/OneDrive/Documentos/Sistemas/Game1/src/server/index.ts#L25-L48))

- **`GET /api/leaderboard`**:
  - Retorna un JSON con el top 15 de mejores partidas registradas:
    ```json
    { "entries": [ { "id": "...", "driver_name": "...", "total_score": 14850, ... } ] }
    ```
- **`POST /api/leaderboard`**:
  - Inserta un nuevo resultado de partida en la tabla de clasificación.

---

### D. Cómo Extender la Persistencia a Base de Datos en Railway

Actualmente, las partidas se guardan en la memoria RAM del servidor Node.js (`this.leaderboard` en `roomManager.ts`) con registros semilla predeterminados. Esto es óptimo para latencia cero.

Si deseas que las partidas queden guardadas **para siempre**, incluso si el servidor se reinicia o se redespliega en Railway:

1. **Opción Archivo Local (`data/leaderboard.json`)**:
   - Guardar con `fs.writeFileSync('data/leaderboard.json', JSON.stringify(this.leaderboard))` cada vez que se agregue un registro.
2. **Opción Base de Datos (PostgreSQL o SQLite en Railway)**:
   - Crear una tabla `matches` (`id`, `room_code`, `driver_name`, `navigator_name`, `score`, `created_at`).
   - Reemplazar `this.leaderboard.push(entry)` por una consulta `INSERT INTO matches ...`.
