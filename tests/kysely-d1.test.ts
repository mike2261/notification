import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { D1Dialect } from "../src/datastore/d1/kysely-d1";

type DB = { parents: { parent_id: string; timezone: string; locale: string } };

describe("D1Dialect", () => {
  it("round-trips a row through Kysely against real D1", async () => {
    const db = new Kysely<DB>({ dialect: new D1Dialect({ database: env.NOTI_D1 }) });
    await db.insertInto("parents").values({ parent_id: "p1", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" }).execute();
    const row = await db.selectFrom("parents").selectAll().where("parent_id", "=", "p1").executeTakeFirst();
    expect(row).toEqual({ parent_id: "p1", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" });
  });
});
