// MUST stay the first import: switches arktype to jitless before any schema
// module can evaluate (Workers forbids `new Function` outside script startup).
import "./arktype-config";
import { app } from "./fetch";

// Static import, no lazy-load boundary. robo-worker's dynamic-import gymnastics
// exist to dodge deploy-validator error 10021 on a much larger dependency
// graph; tuni-noti has no such graph (design.md §4.1). `check:deploy` keeps the
// 300 ms startup tripwire so we find out if that ever stops being true.
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
