// Sitio de contenido de Patrulla Huellitas.
// - Páginas prerenderizadas (HTML estático): inicio, blog, bases, privacidad.
// - Keystatic (/keystatic y /api/keystatic) se ejecuta bajo demanda.
// - El adaptador Node en modo "middleware" se monta dentro del servidor Express del juego.
import markdoc from '@astrojs/markdoc';
import node from '@astrojs/node';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import keystatic from '@keystatic/astro';
import { defineConfig } from 'astro/config';

// Dominio público (canonical, sitemap). Cámbialo con SITE_URL cuando tengas dominio propio.
const site = process.env.SITE_URL || 'https://pacific-speed-production.up.railway.app';

export default defineConfig({
  site,
  output: 'static',
  adapter: node({ mode: 'middleware' }),
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [
    react(),
    markdoc(),
    keystatic(),
    sitemap({
      filter: (page) => !page.includes('/keystatic')
    })
  ]
});
