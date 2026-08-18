import test from "node:test";
import assert from "node:assert/strict";
import { parseMicrosInventoryConsumptions, parseMicrosInventoryConsumptionsEnriched } from "./consumoParser.js";
import type { ConsumoJsonExport } from "../../types/consumos.js";

const sampleJson: ConsumoJsonExport = [
  [
    {
      "Record Type": "INVID",
      "Store Number": "Lab9999",
      "Store Name": "Lab Store",
      "First Business Date": "20260803",
      "Last Business Date": "20260803",
      "Date Created": "20260804",
      "Time Created": "083015"
    }
  ],
  [
    {
      "Record Type": "INV",
      "IM Inventory Item Code": "BG0018",
      "Inventory Item Name1": "PALADIN 355ml",
      "Inventory Item Number": 566,
      "Standard Unit of Measure Name": "Und",
      "Usage Quantity": -7
    },
    {
      "Record Type": "INV",
      "IM Inventory Item Code": "",
      "Inventory Item Name1": "EMPTY",
      "Inventory Item Number": 0,
      "Standard Unit of Measure Name": "Und",
      "Usage Quantity": -3
    },
    {
      "Record Type": "INV",
      "IM Inventory Item Code": "IN0002",
      "Inventory Item Name1": "ZERO QTY",
      "Inventory Item Number": 999,
      "Standard Unit of Measure Name": "Und",
      "Usage Quantity": 0
    }
  ]
];

test("parseMicrosInventoryConsumptions maps INVID header and positive usage lines", () => {
  const parsed = parseMicrosInventoryConsumptions(sampleJson);

  assert.equal(parsed.storeNumber, "Lab9999");
  assert.equal(parsed.firstBusinessDate, "2026-08-03");
  assert.equal(parsed.lastBusinessDate, "2026-08-03");
  assert.equal(parsed.dateCreated, "2026-08-04");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].itemCode, "BG0018");
  assert.equal(parsed.lines[0].quantity, 7);
});

test("parseMicrosInventoryConsumptionsEnriched maps enriched fields for pos.salida_inventario", () => {
  const parsed = parseMicrosInventoryConsumptionsEnriched(sampleJson);

  assert.equal(parsed.serieTicket, "INV-Lab9999");
  assert.equal(parsed.numeroTicket, 20260803);
  assert.equal(parsed.storeNumber, "Lab9999");
  assert.equal(parsed.storeName, "Lab Store");
  assert.equal(parsed.firstBusinessDate, "2026-08-03");
  assert.equal(parsed.fechaHoraIngreso, "2026-08-04T08:30:15");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].codigoProducto, "BG0018");
  assert.equal(parsed.lines[0].descripcionProducto, "PALADIN 355ml");
  assert.equal(parsed.lines[0].unidadMedida, "Und");
  assert.equal(parsed.lines[0].cantidadSalida, 7);
  assert.equal(parsed.lines[0].codigoPrimitivoProducto, "566");
  assert.equal(parsed.lines[0].precioUnitario, 0);
});
