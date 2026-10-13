# PACIFIC-SPEED

**PACIFIC SPEED: OVERDRIVE (Tactical Stealth Edition v1.0.0)** — Juego arcade cooperativo asimétrico en tiempo real (*Driver + AWACS Navigator*) construido con **TypeScript**, **WebSockets (`ws`)**, **HTML5 Canvas (60 FPS)** y **Web Audio API (DSP de Radio Militar + Banco de Voces Neurales)**, listo para desplegar en **Railway**.

## Comandos Rápidos

```bash
# Instalar dependencias
npm install

# Ejecutar pruebas unitarias (Vitest)
npm test

# Modo desarrollo (Servidor WS + Vite HMR)
npm run dev

# Compilar para producción (Cliente + Servidor)
npm run build

# Iniciar servidor de producción (Puerto 3000 o process.env.PORT)
npm run start
```

## Despliegue en Railway
El repositorio incluye `railway.json` preconfigurado (`NIXPACKS`). Solo conecta este repositorio de GitHub en Railway y se compilará e iniciará automáticamente en un único servicio con healthcheck en `/api/health`.
