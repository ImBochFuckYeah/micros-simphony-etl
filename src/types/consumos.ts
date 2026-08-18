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

export interface ParsedConsumoLineEnriched {
  codigoProducto: string;
  descripcionProducto: string;
  unidadMedida: string;
  cantidadSalida: number;
  codigoPrimitivoProducto: string;
  precioUnitario: number;
}

export interface ParsedConsumoDocumentEnriched {
  serieTicket: string;
  numeroTicket: number;
  storeNumber: string;
  storeName: string;
  firstBusinessDate: string;
  lastBusinessDate: string;
  fechaHoraIngreso: string;
  lines: ParsedConsumoLineEnriched[];
}

export interface ParsedEntradaLine {
  skuProducto: string;
  descripcionProducto: string;
  unidadMedida: string;
  cantidad: number;
  precioUnitario: number;
}

export interface ParsedEntradaDocument {
  serieTicket: string;
  numeroTicket: number;
  storeNumber: string;
  storeName: string;
  firstBusinessDate: string;
  lastBusinessDate: string;
  dateCreated: string;
  lines: ParsedEntradaLine[];
}
