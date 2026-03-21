import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { upload } from './upload';
import { renderViewer } from './viewer';
import { createDb, type Database } from './db';
import { getSession, deleteSession } from './session';

export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
};

export type AppContext = {
  Bindings: Env;
  Variables: { db: Database };
};

const app = new Hono<AppContext>();

app.use('*', async (c, next) => {
  c.set('db', createDb(c.env.DB));
  await next();
});

app.use('/api/*', cors());

app.post('/api/upload', upload);
app.get('/api/sessions/:id', getSession);
app.delete('/api/sessions/:id', deleteSession);
app.get('/:id', renderViewer);

app.notFound((c) => c.redirect('https://perplx.net', 307));

export default app;
