import { createHash } from "node:crypto";
import type {
  MicrosJsonExport,
  MicrosRecord,
  ParsedInvoiceDetail,
  ParsedInvoiceHeader,
  ParsedMicrosSales
} from "../../types/micros.js";

const DETAIL_TYPES = new Set(["CDTL", "MID"]);
const BUCKET_DETAIL_TYPES = new Set(["CDTL", "CMI"]);

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asScalarString = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
};

const asNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

const asDateString = (value: unknown): string => {
  const raw = asString(value).trim();
  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }

  return raw;
};

const recordTypeOf = (record: MicrosRecord | undefined): string => asString(record?.["Record Type"]);

const isHomogeneousGroup = (group: MicrosRecord[]): boolean => {
  if (group.length <= 1) return true;
  const firstType = recordTypeOf(group[0]);
  return group.every((record) => recordTypeOf(record) === firstType);
};

const buildBucketKey = (record: MicrosRecord, checkField: string): string => {
  const revenueCenter = asScalarString(record["Revenue Center Number"]);
  const orderType = asScalarString(record["Order Type Number"]);
  const checkNumber = asScalarString(record[checkField]);
  return `${revenueCenter}|${orderType}|${checkNumber}`;
};

const asLookupKey = (value: unknown): string => asScalarString(value).trim();

const normalizeIdSegment = (value: string, fallback: string): string => {
  const normalized = value.trim().replace(/[^A-Za-z0-9]+/g, "_");
  return normalized ? normalized : fallback;
};

const upsertProductCatalogEntry = (catalog: Map<string, string>, record: MicrosRecord): void => {
  const itemDescription =
    asScalarString(record["Menu Item Name"]).trim() ||
    asScalarString(record["Menu Item Name1"]).trim() ||
    asScalarString(record["Menu Item Master Name"]).trim() ||
    asScalarString(record["Master Item Name"]).trim();

  if (!itemDescription) return;

  const candidateKeys = [
    asLookupKey(record["Menu Item Number"]),
    asLookupKey(record["Menu Item Master Number"]),
    asLookupKey(record["Master Item Pos Ref Num"]),
    asLookupKey(record["Pos Transaction Reference"])
  ].filter(Boolean);

  for (const key of candidateKeys) {
    if (!catalog.has(key)) {
      catalog.set(key, itemDescription);
    }
  }
};

const buildProductCatalog = (recordsByType: Map<string, MicrosRecord[]>): Map<string, string> => {
  const catalog = new Map<string, string>();

  for (const recordType of ["MNPR", "CMI", "MID"]) {
    for (const record of recordsByType.get(recordType) ?? []) {
      upsertProductCatalogEntry(catalog, record);
    }
  }

  return catalog;
};

const extractDetailDescription = (detailRecord: MicrosRecord, fallback = ""): string =>
  asScalarString(detailRecord["Description"]) ||
  asScalarString(detailRecord["Descripcion"]) ||
  asScalarString(detailRecord["Menu Item Name1"]) ||
  asScalarString(detailRecord["Menu Item Name2"]) ||
  asScalarString(detailRecord["Menu Item Name"]) ||
  asScalarString(detailRecord["Menu Item Master Name1"]) ||
  asScalarString(detailRecord["Menu Item Master Name2"]) ||
  asScalarString(detailRecord["Menu Item Master Name"]) ||
  asScalarString(detailRecord["Item Description"]) ||
  asScalarString(detailRecord["Menu Item"]) ||
  asScalarString(detailRecord["Master Item Name"]) ||
  asScalarString(detailRecord["Master Item Desc"]) ||
  fallback;

const buildDetailFromBucketRecord = (
  detailRecord: MicrosRecord,
  externalId: string,
  index: number,
  fallbackItemCode: string,
  productCatalog: Map<string, string>
): ParsedInvoiceDetail => {
  const itemCode =
    asLookupKey(detailRecord["Menu Item Number"]) ||
    asLookupKey(detailRecord["Menu Item Master Number"]) ||
    asLookupKey(detailRecord["Master Item Pos Ref Num"]) ||
    asLookupKey(detailRecord["Pos Transaction Reference"]) ||
    fallbackItemCode ||
    "UNMAPPED_ITEM";

  return {
    externalId,
    lineNumber: asNumber(detailRecord["Line Number"], index + 1),
    itemCode,
    quantity:
      asNumber(detailRecord["Line Count"], Number.NaN) ||
      asNumber(detailRecord["Line Quantity"], Number.NaN) ||
      asNumber(detailRecord["Report Line Count"], Number.NaN) ||
      1,
    lineAmount:
      asNumber(detailRecord["Line Total"], Number.NaN) ||
      asNumber(detailRecord["Report Line Total"], Number.NaN) ||
      asNumber(detailRecord.Amount),
    itemDescription: extractDetailDescription(detailRecord, productCatalog.get(itemCode) || itemCode),
    rawDetail: detailRecord
  };
};

const parseBucketedMicrosSales = (microsJson: MicrosJsonExport): ParsedMicrosSales => {
  const headers: ParsedInvoiceHeader[] = [];
  const details: ParsedInvoiceDetail[] = [];
  const recordsByType = new Map<string, MicrosRecord[]>();

  for (const group of microsJson) {
    if (!Array.isArray(group) || group.length === 0) {
      continue;
    }

    const type = recordTypeOf(group[0]);
    const existing = recordsByType.get(type) ?? [];
    existing.push(...group);
    recordsByType.set(type, existing);
  }

  const productCatalog = buildProductCatalog(recordsByType);
  const headerRecords = recordsByType.get("CHDR") ?? [];
  const cmiByKey = new Map<string, MicrosRecord[]>();
  const cdtlByKey = new Map<string, MicrosRecord[]>();

  for (const detailRecord of recordsByType.get("CMI") ?? []) {
    const key = buildBucketKey(detailRecord, "Guest Check number");
    const existing = cmiByKey.get(key) ?? [];
    existing.push(detailRecord);
    cmiByKey.set(key, existing);
  }

  for (const detailRecord of recordsByType.get("CDTL") ?? []) {
    const key = buildBucketKey(detailRecord, "Check Number");
    const existing = cdtlByKey.get(key) ?? [];
    existing.push(detailRecord);
    cdtlByKey.set(key, existing);
  }

  for (const header of headerRecords) {
    const key = buildBucketKey(header, "Check Number");
    const externalId = buildExternalId([header], header);
    const cmiDetails = cmiByKey.get(key) ?? [];
    const cdtlDetails = cdtlByKey.get(key) ?? [];
    const bucketDetails = cmiDetails.length > 0 ? cmiDetails : cdtlDetails;
    const totalAmount = asNumber(header["Check Total"], asNumber(header["Total Amount"]));

    if (bucketDetails.length === 0 && totalAmount === 0) {
      continue;
    }

    headers.push({
      externalId,
      businessDate: asDateString(header["Close Business Date"] ?? header["Open Business Date"] ?? header["Business Date"]),
      totalAmount,
      rawHeader: header
    });

    bucketDetails.forEach((detailRecord, index) => {
      details.push(
        buildDetailFromBucketRecord(
          detailRecord,
          externalId,
          index,
          asLookupKey(detailRecord["Master Item Pos Ref Num"]) || "UNMAPPED_ITEM",
          productCatalog
        )
      );
    });
  }

  return { headers, details };
};

const buildExternalId = (group: MicrosRecord[], header?: MicrosRecord): string => {
  const sourceHeader = header ?? group.find((record) => record["Record Type"] === "CHDR");
  const chdrId = group.find((record) => record["Record Type"] === "CHDRID");
  const invId = group.find((record) => record["Record Type"] === "INVID");

  const recordType = normalizeIdSegment(recordTypeOf(sourceHeader) || "CHDR", "CHDR");
  const businessDate = normalizeIdSegment(
    asDateString(
      sourceHeader?.["Close Business Date"] ?? sourceHeader?.["Open Business Date"] ?? sourceHeader?.["Business Date"]
    ).replace(/-/g, ""),
    "00000000"
  );
  const revenueCenter = normalizeIdSegment(
    asLookupKey(sourceHeader?.["Revenue Center Number"]) || asLookupKey(sourceHeader?.["Revenue Center Master Number"]),
    "NA"
  );
  const orderType = normalizeIdSegment(
    asLookupKey(sourceHeader?.["Order Type Number"]) || asLookupKey(sourceHeader?.["Order Type Master Number"]),
    "NA"
  );
  const checkOrInvoice = normalizeIdSegment(
    asLookupKey(chdrId?.["Check Number"]) ||
      asLookupKey(invId?.["Invoice Number"]) ||
      asLookupKey(sourceHeader?.["Check Number"]) ||
      asLookupKey(sourceHeader?.["Invoice Number"]) ||
      asLookupKey(sourceHeader?.["Check ID"]),
    ""
  );

  if (checkOrInvoice) {
    return `MICROS-${recordType}-${businessDate}-${revenueCenter}-${orderType}-${checkOrInvoice}`;
  }

  const hashSuffix = createHash("sha256").update(JSON.stringify(group)).digest("hex").slice(0, 16);

  return `MICROS-${recordType}-${businessDate}-${revenueCenter}-${orderType}-HASH_${hashSuffix}`;
};

export const parseMicrosSales = (microsJson: MicrosJsonExport): ParsedMicrosSales => {
  const recordsByType = new Map<string, MicrosRecord[]>();

  for (const group of microsJson) {
    if (!Array.isArray(group) || group.length === 0) continue;
    const type = recordTypeOf(group[0]);
    const existing = recordsByType.get(type) ?? [];
    existing.push(...group);
    recordsByType.set(type, existing);
  }

  const productCatalog = buildProductCatalog(recordsByType);

  if (
    microsJson.length > 0 &&
    microsJson.every((group) => Array.isArray(group) && isHomogeneousGroup(group)) &&
    microsJson.some((group) => group.some((record) => BUCKET_DETAIL_TYPES.has(recordTypeOf(record))))
  ) {
    return parseBucketedMicrosSales(microsJson);
  }

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
      const itemCode =
        asLookupKey(detailRecord["Menu Item Number"]) ||
        asLookupKey(detailRecord["Menu Item Master Number"]) ||
        asString(detailRecord["Menu Item"], "UNMAPPED_ITEM");
      details.push({
        externalId,
        lineNumber: index + 1,
        itemCode,
        itemDescription: extractDetailDescription(detailRecord, productCatalog.get(itemCode) || itemCode),
        quantity: asNumber(detailRecord.Quantity, 1),
        lineAmount: asNumber(detailRecord.Amount),
        rawDetail: detailRecord
      });
    });
  }

  return { headers, details };
};
