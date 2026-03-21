import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";

const imageSchema = z.object({
  url: z.string(),
  alt: z.string(),
});

const customers = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/customers" }),
  schema: z.object({
    customer: z.string(),
    ctaTitle: z.string().optional(),
    testimonial: z.string().optional(),
    partnership: z.string().optional(),
    avatar: imageSchema,
    challengesAndSolutions: z.array(
      z.object({
        title: z.string(),
        content: z.string(),
      })
    ),
    results: z.array(z.string()),
    about: z.string(),
    details: z.record(z.string(), z.string()),
    logo: imageSchema,
  }),
});

const integrations = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/integrations" }),
  schema: z.object({
    email: z.string(),
    integration: z.string(),
    description: z.string(),
    permissions: z.array(z.string()),
    details: z.array(
      z.object({
        title: z.string(),
        value: z.string(),
        url: z.string().optional(),
      })
    ),
    logo: imageSchema,
    tags: z.array(z.string()),
  }),
});

const helpcenter = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/helpcenter" }),
  schema: z.object({
    title: z.string(),
    intro: z.string(),
  }),
});

const changelog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/changelog" }),
  schema: z.object({
    page: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
  }),
});

const infopages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/infopages" }),
  schema: z.object({
    page: z.string(),
    pubDate: z.coerce.date(),
  }),
});

const team = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/team" }),
  schema: z.object({
    name: z.string(),
    bio: z.string().optional(),
    role: z.string().optional(),
    image: imageSchema,
    socials: z
      .object({
        twitter: z.string().optional(),
        website: z.string().optional(),
        linkedin: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
  }),
});

const postsCollection = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    description: z.string(),
    team: z.string(),
    image: imageSchema,
    tags: z.array(z.string()),
  }),
});

export const collections = {
  team,
  customers,
  changelog,
  infopages,
  helpcenter,
  posts: postsCollection,
  integrations,
};
