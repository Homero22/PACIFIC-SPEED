import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

export const CATEGORY_LABELS: Record<Post['data']['category'], string> = {
  guias: 'Guía',
  diario: 'Diario del proyecto',
  juego: 'El juego',
  transparencia: 'Transparencia'
};

/** Published articles (drafts hidden), newest first. */
export async function publishedPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.publishedDate.getTime() - a.data.publishedDate.getTime());
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('es-EC', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
