import type { ConsumoJsonExport, ConsumoRecord, ParsedEntradaDocument, ParsedEntradaLine } from "../../types/consumos.js";

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value.trim() : fallback;

const asNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
};

const formatDateOnly = (value: string): string => {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8) {
    throw new Error(`Invalid date value '${value}' in entrada file`);
  }

  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
};

/**
 * Derives a numeric ticket number from a business date string (YYYYMMDD → integer).
 * Falls back to 0 if the date cannot be parsed.
 */
const dateToTicketNumber = (dateStr: string): number => {
  const digits = dateStr.replace(/\D/g, "");
  if (digits.length < 8) return 0;
  const parsed = Number(digits.slice(0, 8));
  return Number.isFinite(parsed) ? parsed : 0;
};

const findFirstRecordByType = (groups: ConsumoJsonExport, recordType: string): ConsumoRecord | null => {
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const record of group) {
      if (asString(record["Record Type"]).toUpperCase() === recordType.toUpperCase()) {
        return record;
      }
    }
  }

  return null;
};

const collectRecordsByType = (groups: ConsumoJsonExport, recordType: string): ConsumoRecord[] => {
  const normalizedType = recordType.toUpperCase();
  const records: ConsumoRecord[] = [];

  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const record of group) {
      if (asString(record["Record Type"]).toUpperCase() === normalizedType) {
        records.push(record);
      }
    }
  }

  return records;
};

const mapInvRecordToEntradaLine = (record: ConsumoRecord): ParsedEntradaLine | null => {
  const skuProducto = asString(record["IM Inventory Item Code"]);
  const cantidad = Math.abs(asNumber(record["Receipt Quantity"], 0));

  if (!skuProducto || cantidad <= 0) {
    return null;
  }

  return {
    skuProducto,
    descripcionProducto: asString(record["Inventory Item Name1"]),
    unidadMedida: asString(record["Standard Unit of Measure Name"]),
    cantidad,
    precioUnitario: asNumber(record["Receipt Value"], 0)
  };
};

export const parseMicrosInventoryEntries = (entradaJson: ConsumoJsonExport): ParsedEntradaDocument => {
  const invid = findFirstRecordByType(entradaJson, "INVID");
  if (!invid) {
    throw new Error("ENTRADA file does not include an INVID record");
  }

  const storeNumber = asString(invid["Store Number"]);
  if (!storeNumber) {
    throw new Error("ENTRADA file INVID record is missing Store Number");
  }

  const firstBusinessDateRaw = asString(invid["First Business Date"]);
  if (!firstBusinessDateRaw) {
    throw new Error("ENTRADA file INVID record is missing First Business Date");
  }

  const lastBusinessDateRaw = asString(invid["Last Business Date"] || invid["First Business Date"]);
  const dateCreatedRaw = asString(invid["Date Created"] || invid["First Business Date"]);

  const firstBusinessDate = formatDateOnly(firstBusinessDateRaw);

  // serie_ticket = "INV-<StoreNumber>", numero_ticket = YYYYMMDD as integer
  const serieTicket = `INV-${storeNumber}`;
  const numeroTicket = dateToTicketNumber(firstBusinessDateRaw);

  const lines = collectRecordsByType(entradaJson, "INV")
    .map(mapInvRecordToEntradaLine)
    .filter((line): line is ParsedEntradaLine => line !== null);

  return {
    serieTicket,
    numeroTicket,
    storeNumber,
    storeName: asString(invid["Store Name"]),
    firstBusinessDate,
    lastBusinessDate: formatDateOnly(lastBusinessDateRaw),
    dateCreated: formatDateOnly(dateCreatedRaw),
    lines
  };
};
