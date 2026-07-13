import test from "node:test";
import assert from "node:assert/strict";
import { parseMicrosSales } from "./microsParser.js";
import type { MicrosJsonExport } from "../../types/micros.js";

test("parseMicrosSales separates CHDR headers and CDTL/MID details", () => {
  const sample: MicrosJsonExport = [
    [
      { "Record Type": "CHDRID", "Check Number": "CHK-1001" },
      { "Record Type": "CHDR", "Business Date": "2026-07-12", "Total Amount": "125.50" },
      { "Record Type": "CDTL", "Menu Item": "ITEM-01", Quantity: "2", Amount: "100.00" },
      { "Record Type": "MID", "Menu Item": "ITEM-02", Quantity: 1, Amount: 25.5 }
    ]
  ];

  const parsed = parseMicrosSales(sample);

  assert.equal(parsed.headers.length, 1);
  assert.equal(parsed.headers[0].externalId, "CHK-1001");
  assert.equal(parsed.headers[0].totalAmount, 125.5);

  assert.equal(parsed.details.length, 2);
  assert.equal(parsed.details[0].itemCode, "ITEM-01");
  assert.equal(parsed.details[1].itemCode, "ITEM-02");
  assert.equal(parsed.details[0].lineNumber, 1);
  assert.equal(parsed.details[1].lineNumber, 2);
});

test("parseMicrosSales ignores groups without CHDR", () => {
  const sample: MicrosJsonExport = [[{ "Record Type": "CDTL", "Menu Item": "ITEM-ORPHAN", Amount: 99 }]];

  const parsed = parseMicrosSales(sample);

  assert.equal(parsed.headers.length, 0);
  assert.equal(parsed.details.length, 0);
});

test("parseMicrosSales generates deterministic fallback externalId", () => {
  const sample: MicrosJsonExport = [[{ "Record Type": "CHDR", "Business Date": "2026-07-12", "Total Amount": 10 }]];

  const first = parseMicrosSales(sample);
  const second = parseMicrosSales(sample);

  assert.equal(first.headers[0].externalId, second.headers[0].externalId);
});
