ALTER TABLE `catalog`
    ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `catalog`
    ADD `creator_name` text;--> statement-breakpoint
ALTER TABLE `catalog`
    ADD `creator_color` text;--> statement-breakpoint
CREATE INDEX `idx_catalog_created_by` ON `catalog` (`created_by`);