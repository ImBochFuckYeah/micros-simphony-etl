import { createHash } from "node:crypto";
import type {
  MicrosJsonExport,
  MicrosRecord,
  ParsedInvoiceDetail,
  ParsedInvoiceHeader,
  ParsedMicrosSales
} from "../../types/micros.js";

const DETAIL_TYPES = new Set(["CDTL", "MID"]);

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

const buildExternalId = (group: MicrosRecord[], header?: MicrosRecord): string => {
  const chdrId = group.find((record) => record["Record Type"] === "CHDRID");
  const invId = group.find((record) => record["Record Type"] === "INVID");

  return (
    asString(chdrId?.["Check Number"]) ||
    asString(invId?.["Invoice Number"]) ||
    asString(header?.["Check Number"]) ||
    asString(header?.["Invoice Number"]) ||
    `MICROS-${createHash("sha256").update(JSON.stringify(group)).digest("hex").slice(0, 16)}`
  );
};

export const parseMicrosSales = (microsJson: MicrosJsonExport): ParsedMicrosSales => {
  const headers: ParsedInvoiceHeader[] = [];
  const details: ParsedInvoiceDetail[] = [];

  for (const group of microsJson) {
    const header = group.find((record) => record["Record Type"] === "CHDR");
    if (!header) {
      continue;
    }

    const externalId = buildExternalId(group, header);

    headers.push({
      externalId,
      businessDate: asString(header["Business Date"]),
      totalAmount: asNumber(header["Total Amount"]),
      rawHeader: header
    });

    const detailRecords = group.filter((record) => DETAIL_TYPES.has(record["Record Type"]));

    detailRecords.forEach((detailRecord, index) => {
      details.push({
        externalId,
        lineNumber: index + 1,
        itemCode: asString(detailRecord["Menu Item"], "UNMAPPED_ITEM"),
        quantity: asNumber(detailRecord.Quantity, 1),
        lineAmount: asNumber(detailRecord.Amount),
        rawDetail: detailRecord
      });
    });
  }

  return { headers, details };
};
