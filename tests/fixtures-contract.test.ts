import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { eventV1 } from "../src/events/v1";

// workerd has no host filesystem access, so fixtures are bundled at build
// time via import.meta.glob rather than read at runtime with node:fs.
const fixtures = import.meta.glob("./fixtures/events/*.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>;

describe("event fixtures — contract", () => {
  it("every fixture file parses as declared by its filename", () => {
    const entries = Object.entries(fixtures);
    expect(entries.length).toBeGreaterThan(0);

    for (const [filePath, json] of entries) {
      const file = filePath.split("/").at(-1) as string;
      const out = eventV1(json);
      const isNegative = file.startsWith("negative.");
      const failed = out instanceof type.errors;
      expect(failed, `${file}: expected ${isNegative ? "REJECT" : "ACCEPT"}, got ${failed ? "REJECT" : "ACCEPT"}`).toBe(
        isNegative,
      );
    }
  });
});
