CREATE TABLE `friend_group_members` (
	`group_id` text NOT NULL,
	`friend_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `friend_id`)
);
--> statement-breakpoint
CREATE TABLE `friend_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_friend_groups_owner` ON `friend_groups` (`owner_id`);--> statement-breakpoint
CREATE TABLE `friend_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`responded_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_friend_requests_recipient` ON `friend_requests` (`recipient_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_friend_requests_requester` ON `friend_requests` (`requester_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `friend_requests_requester_id_recipient_id_unique` ON `friend_requests` (`requester_id`,`recipient_id`);--> statement-breakpoint
CREATE TABLE `friendships` (
	`user_id` text NOT NULL,
	`friend_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `friend_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_friendships_user` ON `friendships` (`user_id`);--> statement-breakpoint
CREATE TABLE `game_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_id` text NOT NULL,
	`inviter_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`responded_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_game_invites_recipient` ON `game_invites` (`recipient_id`,`status`);