import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { raw } from 'hono/html';
import { schema } from './db';
import type { AppContext } from './index';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

const NotFound = () => (
  <html>
    <head>
      <title>Not Found</title>
      <link rel="icon" type="image/png" href="/logo.png" />
      <link rel="stylesheet" href="/viewer.css" />
    </head>
    <body>
      <div class="not-found">Session not found.</div>
    </body>
  </html>
);

const Viewer = ({
  title,
  model,
  date,
  sessionId,
  entryCount,
  sizeBytes
}: {
  title: string;
  model: string;
  date: string;
  sessionId: string;
  entryCount: number;
  sizeBytes: number;
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — Perplexity Code</title>
      <link rel="icon" type="image/png" href="/logo.png" />
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/base16/tomorrow-night.min.css" />
      <link rel="stylesheet" href="/viewer.css" />
    </head>
    <body>
      <div class="layout">
        <div class="main">
          <div class="title-bar">
            <a href="https://perplx.net" draggable="false">
              <img src="/logo.png" alt="Perplx" class="title-logo" draggable="false" />
            </a>
            <h1>{title}</h1>
          </div>
          <div class="content" id="root">
            <div class="loading">Loading…</div>
          </div>
        </div>
        <aside class="sidebar">
          <div class="sidebar-section">
            <h2>Session</h2>
            <div class="sidebar-row">
              <span class="label">Model</span>
              <span>{model}</span>
            </div>
            <div class="sidebar-row">
              <span class="label">Date</span>
              <span>{date}</span>
            </div>
            <div class="sidebar-row">
              <span class="label">Entries</span>
              <span>{entryCount}</span>
            </div>
            <div class="sidebar-row">
              <span class="label">Size</span>
              <span>{formatBytes(sizeBytes)}</span>
            </div>
          </div>
          <hr class="sidebar-divider" />
          <div class="sidebar-section">
            <h2>ID</h2>
            <div class="sidebar-row" style="word-break:break-all;font-family:SF Mono,Menlo,monospace;font-size:0.7rem">
              {sessionId}
            </div>
          </div>
        </aside>
      </div>
      <script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
      <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>
      <script>{raw(`const SESSION_ID="${sessionId}";`)}</script>
      <script src="/viewer.js"></script>
    </body>
  </html>
);

export async function renderViewer(c: Context<AppContext, '/:id'>) {
  const id = c.req.param('id');
  const db = c.get('db');

  const meta = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, id)
  });

  if (!meta) {
    return c.html(<NotFound />, 404);
  }

  const rawTitle = meta.title || 'Shared Session';
  const title = rawTitle.length > 50 ? rawTitle.slice(0, 50) + '...' : rawTitle;

  return c.html(
    <Viewer
      title={title}
      model={meta.model}
      date={new Date(meta.createdAt).toLocaleDateString()}
      sessionId={id}
      entryCount={meta.entryCount}
      sizeBytes={meta.sizeBytes}
    />
  );
}
