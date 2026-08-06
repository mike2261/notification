import { Kysely } from "kysely";
import { D1Dialect } from "./kysely-d1";

export interface Database {
  inbox: InboxTable;
  parents: ParentsTable;
  children: ChildrenTable;
  push_tokens: PushTokensTable;
  preferences: PreferencesTable;
  coalesce_events: CoalesceEventsTable;
  notifications: NotificationsTable;
  deliveries: DeliveriesTable;
  caps: CapsTable;
}

export interface InboxTable {
  event_id: string;
  type: string;
  state: "processed" | "ignored";
  payload_json: string;
  received_at: string;
}

export interface ParentsTable {
  parent_id: string;
  timezone: string;
  locale: string;
}

export interface ChildrenTable {
  child_id: string;
  parent_id: string;
  name: string;
  identity_updated_at: string;
  deleted_at: string | null;
}

export interface PushTokensTable {
  token: string;
  device_id: string;
  parent_id: string;
  platform: string;
  last_seen_at: string;
  disabled_at: string | null;
}

export interface PreferencesTable {
  parent_id: string;
  progress_enabled: number; // 0 | 1 — D1 has no native boolean
  weekly_enabled: number;
  quiet_start: string | null;
  quiet_end: string | null;
  daily_cap: number;
}

export interface CoalesceEventsTable {
  event_id: string;
  window_key: string;
  scope: "child" | "parent";
  child_id: string | null;
  parent_id: string;
  kind: string;
  payload_json: string;
  arrived_at: string;
}

export interface NotificationsTable {
  id: string;
  parent_id: string;
  child_id: string | null;
  kind: string;
  title: string;
  body: string;
  data_json: string;
  scheduled_for: string;
  enqueued_at: string | null;
  state: "scheduled" | "enqueued" | "done" | "deferred_quiet" | "suppressed_cap" | "suppressed_dark" | "canceled";
  dedupe_key: string;
}

export interface DeliveriesTable {
  notification_id: string;
  token: string;
  state: "pending" | "accepted" | "failed" | "canceled";
  attempts: number;
  fcm_message_name: string | null;
}

export interface CapsTable {
  parent_id: string;
  local_date: string;
  daily_cap: number;
  sent_count: number;
}

export function getDb(d1: D1Database): Kysely<Database> {
  return new Kysely<Database>({ dialect: new D1Dialect({ database: d1 }) });
}
