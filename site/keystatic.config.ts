import { collection, config, fields } from '@keystatic/core';
import { block } from '@keystatic/core/content-components';

/**
 * Editor de artículos (/keystatic).
 * - Producción: modo GitHub. Quien publica entra con su cuenta de GitHub (necesita permiso de
 *   escritura en el repositorio) y cada artículo se guarda como un commit en `main`.
 * - Pruebas locales: PUBLIC_KEYSTATIC_STORAGE=local guarda los archivos en el disco.
 */
const storage =
  import.meta.env.PUBLIC_KEYSTATIC_STORAGE === 'local'
    ? ({ kind: 'local' } as const)
    : ({ kind: 'github', repo: 'Homero22/PACIFIC-SPEED', pathPrefix: 'site' } as const);

export default config({
  storage,
  ui: {
    brand: { name: 'Patrulla Huellitas' }
  },
  locale: 'en-US',
  collections: {
    blog: collection({
      label: 'Artículos',
      slugField: 'title',
      path: 'src/content/blog/*',
      format: { contentField: 'content' },
      entryLayout: 'content',
      columns: ['title', 'publishedDate'],
      schema: {
        title: fields.slug({
          name: { label: 'Título', validation: { length: { min: 8, max: 90 } } },
          slug: { label: 'Dirección (se genera sola)' }
        }),
        description: fields.text({
          label: 'Resumen',
          description: 'Una o dos frases. Aparece en Google y en la lista del blog.',
          multiline: true,
          validation: { length: { min: 40, max: 180 } }
        }),
        publishedDate: fields.date({
          label: 'Fecha de publicación',
          defaultValue: { kind: 'today' },
          validation: { isRequired: true }
        }),
        category: fields.select({
          label: 'Sección',
          options: [
            { label: 'Guías', value: 'guias' },
            { label: 'Diario del proyecto', value: 'diario' },
            { label: 'El juego', value: 'juego' },
            { label: 'Transparencia', value: 'transparencia' }
          ],
          defaultValue: 'guias'
        }),
        cover: fields.image({
          label: 'Foto de portada',
          description: 'Mejor en horizontal. Usa fotos propias o con permiso.',
          directory: 'src/assets/blog',
          publicPath: '../../assets/blog/'
        }),
        coverAlt: fields.text({
          label: 'Descripción de la foto',
          description: 'Qué se ve en la foto (para personas ciegas y para Google).'
        }),
        draft: fields.checkbox({
          label: 'Borrador',
          description: 'Mientras esté marcado, el artículo no aparece en el sitio.',
          defaultValue: false
        }),
        content: fields.markdoc({
          label: 'Contenido',
          options: {
            image: {
              directory: 'src/assets/blog',
              publicPath: '../../assets/blog/'
            }
          },
          components: {
            youtube: block({
              label: 'Video de YouTube',
              schema: {
                url: fields.url({
                  label: 'Enlace del video',
                  description: 'Ej: https://www.youtube.com/watch?v=… o https://youtu.be/…',
                  validation: { isRequired: true }
                }),
                title: fields.text({ label: 'Título del video' })
              }
            })
          }
        })
      }
    })
  }
});
