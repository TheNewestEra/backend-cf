CREATE TABLE `sessions`
(
    `token`      text PRIMARY KEY NOT NULL,
    `user_id`    text             NOT NULL,
    `created_at` integer          NOT NULL,
    `expires_at` integer          NOT NULL,
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users`
(
    `id`             text PRIMARY KEY       NOT NULL,
    `username`       text                   NOT NULL,
    `username_lower` text                   NOT NULL,
    `code_hash`      text                   NOT NULL,
    `code_salt`      text                   NOT NULL,
    `created_at`     integer                NOT NULL,
    `color`          text DEFAULT '#888888' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_lower_unique` ON `users` (`username_lower`);