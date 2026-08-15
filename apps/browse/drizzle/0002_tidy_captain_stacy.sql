ALTER TABLE `catalog`
    ADD `replay_of` text;--> statement-breakpoint
ALTER TABLE `catalog`
    ADD `root_id` text;--> statement-breakpoint
CREATE INDEX `idx_catalog_root_created` ON `catalog` (`root_id`, "created_at" desc);