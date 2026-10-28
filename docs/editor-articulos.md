# Editor de artículos (Keystatic + GitHub)

El blog se escribe desde `https://TU-DOMINIO/keystatic`. Quien publica entra con su cuenta de
GitHub; cada artículo se guarda como un commit en `main` y Railway vuelve a desplegar el sitio
(1–2 minutos). Todo es gratis: no hay suscripciones.

## Configuración (una sola vez)

### 1. Crear la GitHub App desde tu computadora

```bash
cd site
npm install
PUBLIC_KEYSTATIC_STORAGE=github npm run dev
```

Abre `http://127.0.0.1:4321/keystatic`. Keystatic muestra un asistente:

1. Escribe un nombre para la app (por ejemplo `patrulla-huellitas-editor`) y pulsa **Create GitHub App**.
2. GitHub te pide confirmar: créala en tu cuenta (`Homero22`).
3. Al volver, Keystatic escribe un archivo `site/.env` con cuatro valores:
   - `KEYSTATIC_GITHUB_CLIENT_ID`
   - `KEYSTATIC_GITHUB_CLIENT_SECRET`
   - `KEYSTATIC_SECRET`
   - `PUBLIC_KEYSTATIC_GITHUB_APP_SLUG`

   **No subas ese archivo a GitHub** (ya está en `.gitignore`).
4. Cuando te lo pida, **instala la app** en el repositorio `Homero22/PACIFIC-SPEED` (solo ese repositorio).

### 2. Permitir el inicio de sesión en producción

En GitHub → Settings → Developer settings → GitHub Apps → tu app → **Callback URL**, agrega:

```
https://TU-DOMINIO/api/keystatic/github/oauth/callback
```

(Deja también la de `http://127.0.0.1:4321/api/keystatic/github/oauth/callback` para usarlo en local.)

### 3. Variables en Railway

En el servicio → **Variables**, agrega los cuatro valores de `site/.env` y además:

| Variable | Valor |
| --- | --- |
| `KEYSTATIC_GITHUB_CLIENT_ID` | (de `site/.env`) |
| `KEYSTATIC_GITHUB_CLIENT_SECRET` | (de `site/.env`) |
| `KEYSTATIC_SECRET` | (de `site/.env`) |
| `PUBLIC_KEYSTATIC_GITHUB_APP_SLUG` | (de `site/.env`) |
| `SITE_URL` | `https://TU-DOMINIO` (para el sitemap y los enlaces canónicos) |
| `SITE_EXTRA_HOSTS` | (opcional) otros dominios que también apunten al sitio, separados por coma |

Sin las tres primeras, `/keystatic` responde "Editor no configurado" en producción (a propósito).

`SITE_URL` también le dice al servidor en qué dominio confiar para el inicio de sesión con GitHub. Si cambias de dominio, actualízalo y vuelve a desplegar; si no, GitHub intentará volver a `localhost`.

### 4. Dar acceso a otras personas

GitHub → repositorio → **Settings → Collaborators → Add people**, con permiso **Write**.
Esa persona entra a `/keystatic` con su cuenta de GitHub. Quítale el acceso cuando ya no publique.

## Cómo publicar un artículo

1. Entra a `/keystatic` → **Artículos** → **+**.
2. Escribe título, resumen y el texto. Para un video: menú **+** → **Video de YouTube** → pega el enlace.
3. Sube la foto de portada (horizontal, propia o con permiso) y describe qué se ve.
4. Marca **Borrador** si aún no quieres que se vea.
5. **Create / Save**: se guarda en GitHub y el sitio se actualiza en 1–2 minutos.

## A tener en cuenta

- **Cada publicación reinicia el servidor** (Railway vuelve a desplegar). Las partidas en curso se
  cortan. Publica en horas de poca actividad y nunca durante un torneo en marcha.
- **Videos:** súbelos a YouTube y pega el enlace; no subas archivos de video al sitio.
- **Fotos:** Astro las comprime solas, pero evita subir decenas por artículo.
- El editor está en inglés (Keystatic no tiene traducción); los campos están en español.
