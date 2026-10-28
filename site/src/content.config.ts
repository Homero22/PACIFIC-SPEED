import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Artículos escritos desde Keystatic (/keystatic): un archivo .mdoc por artículo.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.mdoc', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      publishedDate: z.coerce.date(),
      category: z.enum(['guias', 'diario', 'juego', 'transparencia']).default('guias'),
      cover: image().optional().nullable(),
      coverAlt: z.string().optional().default(''),
      draft: z.boolean().default(false)
    })
});

export const collections = { blog };
