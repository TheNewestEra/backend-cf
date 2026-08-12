CREATE TABLE `game` (
	`id` text PRIMARY KEY NOT NULL,
	`theme` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`host_token` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT '' NOT NULL,
	`lobby_ends_at` integer,
	`post_round_index` integer,
	`post_round_ends_at` integer,
	`round_count` integer DEFAULT 5 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guesses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_idx` integer NOT NULL,
	`participant_id` text DEFAULT '' NOT NULL,
	`player` text NOT NULL,
	`guess` text NOT NULL,
	`correct` integer NOT NULL,
	`score` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`user_id` text,
	`token` text,
	`color` text DEFAULT '#888888' NOT NULL,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rounds` (
	`idx` integer PRIMARY KEY NOT NULL,
	`prompt` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`image_key` text,
	`ready_at` integer,
	`started_at` integer,
	`time_limit_ms` integer,
	`error` text
);
