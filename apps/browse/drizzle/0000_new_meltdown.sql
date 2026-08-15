CREATE TABLE `catalog`
(
    `id`            text PRIMARY KEY             NOT NULL,
    `kind`          text                         NOT NULL,
    `theme`         text,
    `status`        text    DEFAULT 'generating' NOT NULL,
    `thumbnail_key` text,
    `play_status`   text    DEFAULT 'joinable'   NOT NULL,
    `rating_sum`    integer DEFAULT 0            NOT NULL,
    `rating_count`  integer DEFAULT 0            NOT NULL,
    `created_at`    integer                      NOT NULL,
    `updated_at`    integer                      NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_catalog_created` ON `catalog` ("created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_catalog_kind_created` ON `catalog` (`kind`, "created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_catalog_play_status_created` ON `catalog` (`play_status`, "created_at" desc);--> statement-breakpoint
CREATE TABLE `ratings`
(
    `id`         integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `catalog_id` text    NOT NULL,
    `rater`      text,
    `stars`      integer NOT NULL,
    `created_at` integer NOT NULL,
    FOREIGN KEY (`catalog_id`) REFERENCES `catalog` (`id`) ON UPDATE no action ON DELETE no action,
    CONSTRAINT "stars_between_1_and_5" CHECK ("ratings"."stars" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `idx_ratings_catalog` ON `ratings` (`catalog_id`);