import type { Context } from 'hono';
import { nanoid } from 'nanoid';
import { schema } from './db';
import type { AppContext } from './index';

function tryParse(line: string) {
  try { return JSON.parse(line); } catch { return null; }
}

export async function upload(c: Context<AppContext>) {
  const body = await c.req.arrayBuffer();

  if (body.byteLength === 0) return c.json({ error: 'empty body' }, 400);
  if (body.byteLength > 10 * 1024 * 1024) return c.json({ error: 'session too large (10 MB max)' }, 413);

  const id = nanoid(12);
  const text = new TextDecoder().decode(body);
  const lines = text.trim().split('\n');

  let title = '';
  let model = '';

  for (const line of lines) {
    const entry = tryParse(line);

    if (!entry) continue;
    if (entry.type === 'model_change' && !model) model = `${entry.provider}/${entry.modelId}`;

    const msg = entry.type === 'message' ? entry.message : null;
    if (!title && msg?.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : (msg.content?.[0]?.text ?? '');
      title = content.slice(0, 200);
    }

    if (!model && msg?.role === 'assistant' && msg.model) model = msg.model;
    if (title && model) break;
  }

  await c.env.BUCKET.put(id, body);
  const db = c.get('db');

  await db.insert(schema.sessions).values({
    id,
    title,
    model,
    createdAt: Date.now(),
    sizeBytes: body.byteLength,
    entryCount: lines.length
  });

  return c.json({ id, url: `/${id}` }, 201);
}
