CREATE TABLE `moves`
(
    `id`             integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `participant_id` text    NOT NULL,
    `player`         text    NOT NULL,
    `cell_a`         integer NOT NULL,
    `cell_b`         integer NOT NULL,
    `cells_placed`   integer NOT NULL,
    `score`          integer,
    `created_at`     integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `puzzle`
    ADD `scored_cells` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `puzzle` DROP COLUMN `score`;
