import {type GameKind, playUrlFor} from "@game-worker/shared/game";
import {publicImageUrl} from "@game-worker/shared/images";
import type {FriendsRpc} from "@game-worker/shared/rpc-types";
import type {D1Response} from "@cloudflare/workers-types";
import {and, desc, eq, inArray, ne, sql} from "drizzle-orm";
import {err, ok, type Result} from "neverthrow";
import {
    type CatalogEntry,
    CatalogSort,
    CatalogStatus,
    PlayStatus,
    ReplayKind,
} from "./catalog.schema";
import type {Db} from "./db/client";
import {catalog, ratings} from "./db/schema";

export const insertCatalogEntry = async (
    db: Db,
    id: string,
    kind: GameKind,
    theme: string | null,
    creator: {id: string | null; name: string; color: string},
    replayOf?: string | null,
    themeGenerated?: boolean,
    replayKind?: ReplayKind | null,
): Promise<D1Response> => {
    const rootId =
        replayOf && replayKind === ReplayKind.Replay
            ? ((
                  await db
                      .select({rootId: catalog.rootId})
                      .from(catalog)
                      .where(eq(catalog.id, replayOf))
                      .get()
              )?.rootId ?? replayOf)
            : id;
    return db
        .insert(catalog)
        .values({
            id,
            kind,
            theme,
            themeGenerated: themeGenerated ? 1 : 0,
            status: CatalogStatus.Generating,
            thumbnailKey: null,
            playStatus: PlayStatus.Joinable,
            ratingSum: 0,
            ratingCount: 0,
            createdBy: creator.id,
            creatorName: creator.name,
            creatorColor: creator.color,
            replayOf: replayOf ?? null,
            replayKind: replayOf ? (replayKind ?? null) : null,
            rootId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        })
        .run();
};

export const updateCatalogTheme = (
    db: Db,
    id: string,
    theme: string,
    themeGenerated: boolean,
): Promise<D1Response> =>
    db
        .update(catalog)
        .set({theme, themeGenerated: themeGenerated ? 1 : 0, updatedAt: Date.now()})
        .where(eq(catalog.id, id))
        .run();

export const updatePlayStatus = (db: Db, id: string, playStatus: PlayStatus): Promise<D1Response> =>
    db.update(catalog).set({playStatus, updatedAt: Date.now()}).where(eq(catalog.id, id)).run();

export const markCatalogGenerating = (db: Db, id: string): Promise<D1Response> =>
    db
        .update(catalog)
        .set({status: CatalogStatus.Generating, updatedAt: Date.now()})
        .where(eq(catalog.id, id))
        .run();

export const markCatalogReady = (db: Db, id: string, thumbnailKey: string): Promise<D1Response> =>
    db
        .update(catalog)
        .set({status: CatalogStatus.Ready, thumbnailKey, updatedAt: Date.now()})
        .where(eq(catalog.id, id))
        .run();

export const markCatalogError = (db: Db, id: string): Promise<D1Response> =>
    db
        .update(catalog)
        .set({status: CatalogStatus.Error, updatedAt: Date.now()})
        .where(eq(catalog.id, id))
        .run();

export interface ListCatalogOptions {
    kind: GameKind | null;
    sort: CatalogSort;
    playStatus: PlayStatus | null;
    createdByFriendsOf: string | null;
    limit: number;
    offset: number;
}

const familyId = sql`COALESCE(${catalog.rootId}, ${catalog.id})`;

export const listCatalog = async (
    db: Db,
    friends: FriendsRpc,
    opts: ListCatalogOptions,
    imagesPublicUrl: string,
): Promise<CatalogEntry[]> => {
    const friendIdsList = opts.createdByFriendsOf
        ? await friends.getFriendIds(opts.createdByFriendsOf)
        : null;
    if (friendIdsList && friendIdsList.length === 0) return [];

    const conditions = [
        opts.playStatus
            ? ne(catalog.status, CatalogStatus.Error)
            : eq(catalog.status, CatalogStatus.Ready),
        opts.playStatus ? eq(catalog.playStatus, opts.playStatus) : undefined,
        opts.kind ? eq(catalog.kind, opts.kind) : undefined,
        friendIdsList ? inArray(catalog.createdBy, friendIdsList) : undefined,
    ].filter((condition) => condition !== undefined);

    const family = db
        .select({
            familyId: familyId.as("family_id"),
            maxCreatedAt: sql<number>`MAX(${catalog.createdAt})`.as("max_created_at"),
            instanceCount: sql<number>`COUNT(*)`.as("instance_count"),
            ratingSum: sql<number>`SUM(${catalog.ratingSum})`.as("total_rating_sum"),
            ratingCount: sql<number>`SUM(${catalog.ratingCount})`.as("total_rating_count"),
        })
        .from(catalog)
        .where(and(...conditions))
        .groupBy(familyId)
        .as("family");

    const ratingRatio = sql`CASE WHEN ${family.ratingCount} > 0 THEN ${family.ratingSum} * 1.0 / ${family.ratingCount} ELSE -1 END`;
    const orderBy =
        opts.sort === CatalogSort.Rating
            ? [desc(ratingRatio), desc(catalog.createdAt)]
            : [desc(catalog.createdAt)];

    const rows = await db
        .select({
            id: catalog.id,
            kind: catalog.kind,
            theme: catalog.theme,
            themeGenerated: catalog.themeGenerated,
            status: catalog.status,
            thumbnailKey: catalog.thumbnailKey,
            playStatus: catalog.playStatus,
            ratingSum: family.ratingSum,
            ratingCount: family.ratingCount,
            createdBy: catalog.createdBy,
            creatorName: catalog.creatorName,
            creatorColor: catalog.creatorColor,
            replayOf: catalog.replayOf,
            replayKind: catalog.replayKind,
            createdAt: catalog.createdAt,
            updatedAt: catalog.updatedAt,
            replayCount: sql<number>`${family.instanceCount} - 1`,
        })
        .from(catalog)
        .innerJoin(
            family,
            sql`${familyId} = ${family.familyId} AND ${catalog.createdAt} = ${family.maxCreatedAt}`,
        )
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(opts.limit)
        .offset(opts.offset);

    return rows.map((row) => toPublic(row, imagesPublicUrl));
};

const roundToNearestHalf = (value: number): number => Math.round(value * 2) / 2;

export type RatingResult = {average: number; count: number};

export const submitRating = async (
    db: Db,
    catalogId: string,
    stars: number,
    rater: string | null,
): Promise<Result<RatingResult, string>> => {
    const existing = await db
        .select({ratingSum: catalog.ratingSum, ratingCount: catalog.ratingCount})
        .from(catalog)
        .where(eq(catalog.id, catalogId))
        .get();
    if (!existing) return err("not found");

    const now = Date.now();
    await db.batch([
        db.insert(ratings).values({catalogId, rater, stars, createdAt: now}),
        db
            .update(catalog)
            .set({
                ratingSum: sql`${catalog.ratingSum} + ${stars}`,
                ratingCount: sql`${catalog.ratingCount} + 1`,
                updatedAt: now,
            })
            .where(eq(catalog.id, catalogId)),
    ]);

    return ok({
        average: roundToNearestHalf((existing.ratingSum + stars) / (existing.ratingCount + 1)),
        count: existing.ratingCount + 1,
    });
};

type CatalogRow = Pick<
    typeof catalog.$inferSelect,
    | "id"
    | "kind"
    | "theme"
    | "themeGenerated"
    | "thumbnailKey"
    | "playStatus"
    | "createdBy"
    | "creatorName"
    | "creatorColor"
    | "replayOf"
    | "replayKind"
    | "createdAt"
> & {replayCount: number; ratingSum: number; ratingCount: number};

const toPublic = (row: CatalogRow, imagesPublicUrl: string): CatalogEntry => ({
    id: row.id,
    kind: row.kind,
    theme: row.theme,
    themeGenerated: row.themeGenerated === 1,
    thumbnailUrl: row.thumbnailKey ? publicImageUrl(imagesPublicUrl, row.thumbnailKey) : null,
    playUrl: playUrlFor(row.kind, row.id),
    playStatus: row.playStatus,
    averageRating: row.ratingCount > 0 ? roundToNearestHalf(row.ratingSum / row.ratingCount) : null,
    ratingCount: row.ratingCount,
    createdAt: row.createdAt,
    creator: row.creatorName
        ? {userId: row.createdBy, name: row.creatorName, color: row.creatorColor ?? "#888888"}
        : null,
    replayOf: row.replayOf,
    replayKind: row.replayKind,
    replayCount: row.replayCount,
});
