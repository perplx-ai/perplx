import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default(''),
  model: text('model').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  entryCount: integer('entry_count').notNull()
});
