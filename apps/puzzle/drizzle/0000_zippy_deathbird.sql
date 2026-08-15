CREATE TABLE `participants`
(
    `id`            text PRIMARY KEY       NOT NULL,
    `name`          text                   NOT NULL,
    `user_id`       text,
    `token`         text,
    `color`         text DEFAULT '#888888' NOT NULL,
    `joined_at`     integer                NOT NULL,
    `selected_cell` integer
);
--> statement-breakpoint
CREATE TABLE `puzzle`
(
    `id`            text PRIMARY KEY      NOT NULL,
    `theme`         text,
    `prompt`        text,
    `status`        text DEFAULT 'queued' NOT NULL,
    `error`         text,
    `grid_size`     integer               NOT NULL,
    `board`         text DEFAULT '[]'     NOT NULL,
    `time_limit_ms` integer               NOT NULL,
    `started_at`    integer,
    `lobby_ends_at` integer,
    `ended_at`      integer,
    `score`         integer,
    `solved_by`     text,
    `host_token`    text                  NOT NULL,
    `created_at`    integer               NOT NULL
);
