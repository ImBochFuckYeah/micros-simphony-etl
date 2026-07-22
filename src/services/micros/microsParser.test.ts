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
  assert.equal(parsed.headers[0].externalId, "MICROS-CHDR-20260712-NA-NA-CHK_1001");
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
  assert.match(first.headers[0].externalId, /^MICROS-CHDR-20260712-NA-NA-HASH_[A-Fa-f0-9]{16}$/);
});

test("parseMicrosSales supports type-bucketed RA exports", () => {
  const sample: MicrosJsonExport = [
    [
      {
        "Record Type": "CHDR",
        "Revenue Center Number": 101,
        "Order Type Number": 2,
        "Check Number": 13063,
        "Close Business Date": "20260709000000",
        "Check Total": 37
      },
      {
        "Record Type": "CHDR",
        "Revenue Center Number": 101,
        "Order Type Number": 2,
        "Check Number": 13068,
        "Close Business Date": "20260709000000",
        "Check Total": 0
      }
    ],
    [
      {
        "Record Type": "CMI",
        "Revenue Center Number": 101,
        "Order Type Number": 2,
        "Guest Check number": 13063,
        "Menu Item Number": 103009,
        "Line Number": 1,
        "Line Count": 1,
        "Line Total": 6
      },
      {
        "Record Type": "CMI",
        "Revenue Center Number": 101,
        "Order Type Number": 2,
        "Guest Check number": 13063,
        "Menu Item Number": 302801,
        "Line Number": 2,
        "Line Count": 1,
        "Line Total": 31
      }
    ],
    [
      {
        "Record Type": "CDTL",
        "Revenue Center Number": 101,
        "Order Type Number": 2,
        "Check Number": 13063,
        "Line Quantity": 1,
        "Line Total": 6,
        "Master Item Pos Ref Num": 103009
      }
    ]
  ];

  const parsed = parseMicrosSales(sample);

  assert.equal(parsed.headers.length, 1);
  assert.equal(parsed.headers[0].externalId, "MICROS-CHDR-20260709-101-2-13063");
  assert.equal(parsed.headers[0].businessDate, "2026-07-09");
  assert.equal(parsed.details.length, 2);
  assert.equal(parsed.details[0].itemCode, "103009");
  assert.equal(parsed.details[1].itemCode, "302801");
});

test("parseMicrosSales resolves finished product description from MNPR catalog", () => {
  const sample: MicrosJsonExport = [
    [
      {
        "Record Type": "CHDR",
        "Revenue Center Number": 101,
        "Order Type Number": 2,
        "Check Number": 61,
        "Close Business Date": "20260712000000",
        "Check Total": 10
      }
    ],
    [
      {
        "Record Type": "CDTL",
        "Revenue Center Number": 101,
        "Order Type Number": 2,
        "Check Number": 61,
        "Line Quantity": 1,
        "Line Total": 10,
        "Master Item Pos Ref Num": 301101
      }
    ],
    [
      {
        "Record Type": "MNPR",
        "Menu Item Number": 301101,
        "Menu Item Master Number": 301101,
        "Menu Item Name": "Ensalada"
      }
    ]
  ];

  const parsed = parseMicrosSales(sample);

  assert.equal(parsed.headers.length, 1);
  assert.equal(parsed.details.length, 1);
  assert.equal(parsed.details[0].itemCode, "301101");
  assert.equal(parsed.details[0].itemDescription, "Ensalada");
});
