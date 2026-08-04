import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    officialCheckedAt: z.coerce.date().optional(),
    category: z.enum(['設備投資', '新規事業', '省力化', '資金調達', '申請実務', '制度情報']),
    tags: z.array(z.string()).default([]),
    author: z.string().default('川原 拓馬'),
    reviewer: z.string().optional(),
    officialSources: z.array(z.object({
      title: z.string(),
      url: z.string().url(),
    })).default([]),
    draft: z.boolean().default(true),
    directAnswer: z.string().optional(),
  }),
});

export const collections = { blog };
