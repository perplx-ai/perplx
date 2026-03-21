CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`entry_count` integer NOT NULL
);
