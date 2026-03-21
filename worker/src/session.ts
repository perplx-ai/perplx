import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from './db';
import type { AppContext } from './index';

export async function getSession(c: Context<AppContext, '/:id'>) {
  const id = c.req.param('id');
  const db = c.get('db');

  const meta = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, id)
  });

  if (!meta) {
    return c.json({ error: 'not found' }, 404);
  }

  const obj = await c.env.BUCKET.get(id);
  if (!obj) {
    return c.json({ error: 'session data missing' }, 404);
  }

  const text = await obj.text();
  const entries = text
    .trim()
    .split('\n')
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return c.json({ ...meta, entries });
}

export async function deleteSession(c: Context<AppContext, '/:id'>) {
  const id = c.req.param('id');
  const db = c.get('db');

  await c.env.BUCKET.delete(id);
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));

  return c.json({ ok: true });
}
