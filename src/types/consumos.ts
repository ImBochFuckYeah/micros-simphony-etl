export type ConsumoScalar = string | number | boolean | null;

export interface ConsumoRecord {
  "Record Type": string;
  [key: string]: ConsumoScalar;
}

export type ConsumoJsonExport = ConsumoRecord[][];

export interface ParsedConsumoLine {
  itemCode: string;
  quantity: number;
  costingCode?: string;
}

export interface ParsedConsumoDocument {
  storeNumber: string;
  storeName: string;
  firstBusinessDate: string;
  lastBusinessDate: string;
  dateCreated: string;
  lines: ParsedConsumoLine[];
}
