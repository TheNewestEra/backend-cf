CREATE TABLE `leaderboard_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`session_id` text NOT NULL,
	`score` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_leaderboard_kind_created` ON `leaderboard_entries` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_leaderboard_user` ON `leaderboard_entries` (`user_id`);