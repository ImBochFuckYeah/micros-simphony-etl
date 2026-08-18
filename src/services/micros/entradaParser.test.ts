import test from "node:test";
import assert from "node:assert/strict";
import { parseMicrosInventoryEntries } from "./entradaParser.js";
import type { ConsumoJsonExport } from "../../types/consumos.js";

test("parseMicrosInventoryEntries maps INVID header and positive receipt lines", () => {
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
        "Inventory Item Name1": "PALADIN 355ml",
        "Standard Unit of Measure Name": "Und",
        "Receipt Quantity": 7,
        "Receipt Value": 49
      },
      {
        "Record Type": "INV",
        "IM Inventory Item Code": "",
        "Inventory Item Name1": "EMPTY",
        "Standard Unit of Measure Name": "Und",
        "Receipt Quantity": 3,
        "Receipt Value": 21
      },
      {
        "Record Type": "INV",
        "IM Inventory Item Code": "IN0002",
        "Inventory Item Name1": "ZERO QTY",
        "Standard Unit of Measure Name": "Und",
        "Receipt Quantity": 0,
        "Receipt Value": 0
      }
    ]
  ];

  const parsed = parseMicrosInventoryEntries(sample);

  assert.equal(parsed.serieTicket, "INV-Lab9999");
  assert.equal(parsed.numeroTicket, 20260803);
  assert.equal(parsed.storeNumber, "Lab9999");
  assert.equal(parsed.firstBusinessDate, "2026-08-03");
  assert.equal(parsed.lastBusinessDate, "2026-08-03");
  assert.equal(parsed.dateCreated, "2026-08-04");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].skuProducto, "BG0018");
  assert.equal(parsed.lines[0].descripcionProducto, "PALADIN 355ml");
  assert.equal(parsed.lines[0].unidadMedida, "Und");
  assert.equal(parsed.lines[0].cantidad, 7);
  assert.equal(parsed.lines[0].precioUnitario, 49);
});
