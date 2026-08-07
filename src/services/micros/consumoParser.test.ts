import test from "node:test";
import assert from "node:assert/strict";
import { parseMicrosInventoryConsumptions } from "./consumoParser.js";
import type { ConsumoJsonExport } from "../../types/consumos.js";

test("parseMicrosInventoryConsumptions maps INVID header and positive usage lines", () => {
  const sample: ConsumoJsonExport = [
    [
      {
        "Record Type": "INVID",
        "Store Number": "Lab9999",
        "Store Name": "Lab",
        "First Business Date": "20260803",
        "Last Business Date": "20260803",
        "Date Created": "20260804"
      }
    ],
    [
      {
        "Record Type": "INV",
        "IM Inventory Item Code": "BG0018",
        "Usage Quantity": -7
      },
      {
        "Record Type": "INV",
        "IM Inventory Item Code": "",
        "Usage Quantity": -3
      },
      {
        "Record Type": "INV",
        "IM Inventory Item Code": "IN0002",
        "Usage Quantity": 0
      }
    ]
  ];

  const parsed = parseMicrosInventoryConsumptions(sample);

  assert.equal(parsed.storeNumber, "Lab9999");
  assert.equal(parsed.firstBusinessDate, "2026-08-03");
  assert.equal(parsed.lastBusinessDate, "2026-08-03");
  assert.equal(parsed.dateCreated, "2026-08-04");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].itemCode, "BG0018");
  assert.equal(parsed.lines[0].quantity, 7);
});
