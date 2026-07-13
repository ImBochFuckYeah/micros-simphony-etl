export type MicrosScalar = string | number | boolean | null;

export interface MicrosRecord {
  "Record Type": string;
  [key: string]: MicrosScalar;
}

export type MicrosJsonExport = MicrosRecord[][];

export interface ParsedInvoiceHeader {
  externalId: string;
  businessDate: string;
  totalAmount: number;
  rawHeader: MicrosRecord;
}

export interface ParsedInvoiceDetail {
  externalId: string;
  lineNumber: number;
  itemCode: string;
  quantity: number;
  lineAmount: number;
  rawDetail: MicrosRecord;
}

export interface ParsedMicrosSales {
  headers: ParsedInvoiceHeader[];
  details: ParsedInvoiceDetail[];
}
