import type { ConsumoJsonExport, ConsumoRecord, ParsedConsumoDocument, ParsedConsumoLine } from "../../types/consumos.js";

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
    throw new Error(`Invalid date value '${value}' in consumo file`);
  }

  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
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

const mapInvRecordToLine = (record: ConsumoRecord): ParsedConsumoLine | null => {
  const itemCode = asString(record["IM Inventory Item Code"]);
  const usageQuantity = Math.abs(asNumber(record["Usage Quantity"], 0));

  if (!itemCode || usageQuantity <= 0) {
    return null;
  }

  return {
    itemCode,
    quantity: usageQuantity
  };
};

export const parseMicrosInventoryConsumptions = (consumoJson: ConsumoJsonExport): ParsedConsumoDocument => {
  const invid = findFirstRecordByType(consumoJson, "INVID");
  if (!invid) {
    throw new Error("CONSUMO file does not include an INVID record");
  }

  const storeNumber = asString(invid["Store Number"]);
  if (!storeNumber) {
    throw new Error("CONSUMO file INVID record is missing Store Number");
  }

  const firstBusinessDateRaw = asString(invid["First Business Date"]);
  if (!firstBusinessDateRaw) {
    throw new Error("CONSUMO file INVID record is missing First Business Date");
  }

  const lastBusinessDateRaw = asString(invid["Last Business Date"] || invid["First Business Date"]);
  const dateCreatedRaw = asString(invid["Date Created"] || invid["First Business Date"]);

  const lines = collectRecordsByType(consumoJson, "INV")
    .map(mapInvRecordToLine)
    .filter((line): line is ParsedConsumoLine => line !== null);

  return {
    storeNumber,
    storeName: asString(invid["Store Name"]),
    firstBusinessDate: formatDateOnly(firstBusinessDateRaw),
    lastBusinessDate: formatDateOnly(lastBusinessDateRaw),
    dateCreated: formatDateOnly(dateCreatedRaw),
    lines
  };
};
