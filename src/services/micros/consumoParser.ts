import type {
  ConsumoJsonExport,
  ConsumoRecord,
  ParsedConsumoDocument,
  ParsedConsumoDocumentEnriched,
  ParsedConsumoLine,
  ParsedConsumoLineEnriched
} from "../../types/consumos.js";

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

/**
 * Combines a date string (YYYYMMDD) and a time string (HHmmss) into an ISO timestamp.
 * Falls back to midnight of the given date when the time cannot be parsed.
 */
const buildTimestamp = (dateRaw: string, timeRaw: string): string => {
  const dateDigits = dateRaw.replace(/\D/g, "");
  if (dateDigits.length < 8) {
    throw new Error(`Invalid date value '${dateRaw}' in consumo file`);
  }

  const year = dateDigits.slice(0, 4);
  const month = dateDigits.slice(4, 6);
  const day = dateDigits.slice(6, 8);

  const timeDigits = timeRaw.replace(/\D/g, "").padEnd(6, "0");
  const hour = timeDigits.slice(0, 2);
  const minute = timeDigits.slice(2, 4);
  const second = timeDigits.slice(4, 6);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
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

const mapInvRecordToEnrichedLine = (record: ConsumoRecord): ParsedConsumoLineEnriched | null => {
  const codigoProducto = asString(record["IM Inventory Item Code"]);
  const cantidadSalida = Math.abs(asNumber(record["Usage Quantity"], 0));

  if (!codigoProducto || cantidadSalida <= 0) {
    return null;
  }

  return {
    codigoProducto,
    descripcionProducto: asString(record["Inventory Item Name1"]),
    unidadMedida: asString(record["Standard Unit of Measure Name"]),
    cantidadSalida,
    codigoPrimitivoProducto: String(asNumber(record["Inventory Item Number"], 0)),
    precioUnitario: 0
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

export const parseMicrosInventoryConsumptionsEnriched = (consumoJson: ConsumoJsonExport): ParsedConsumoDocumentEnriched => {
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
  const timeCreatedRaw = asString(invid["Time Created"]);

  const serieTicket = `INV-${storeNumber}`;
  const numeroTicket = dateToTicketNumber(firstBusinessDateRaw);
  const fechaHoraIngreso = buildTimestamp(dateCreatedRaw, timeCreatedRaw);

  const lines = collectRecordsByType(consumoJson, "INV")
    .map(mapInvRecordToEnrichedLine)
    .filter((line): line is ParsedConsumoLineEnriched => line !== null);

  return {
    serieTicket,
    numeroTicket,
    storeNumber,
    storeName: asString(invid["Store Name"]),
    firstBusinessDate: formatDateOnly(firstBusinessDateRaw),
    lastBusinessDate: formatDateOnly(lastBusinessDateRaw),
    fechaHoraIngreso,
    lines
  };
};
