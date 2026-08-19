import assert from "node:assert/strict";
import test from "node:test";
import { resolveProcessingDateRange } from "./processingDateRange.js";

test("resolveProcessingDateRange defaults to the previous day when dates are omitted", () => {
  const range = resolveProcessingDateRange(undefined, undefined, new Date(2026, 7, 19, 14, 30, 0));

  assert.deepEqual(range, {
    startDate: "2026-08-18",
    endDate: "2026-08-18"
  });
});

test("resolveProcessingDateRange keeps end date aligned with an explicit start date", () => {
  const range = resolveProcessingDateRange("2026-08-10", undefined, new Date(2026, 7, 19, 14, 30, 0));

  assert.deepEqual(range, {
    startDate: "2026-08-10",
    endDate: "2026-08-10"
  });
});
