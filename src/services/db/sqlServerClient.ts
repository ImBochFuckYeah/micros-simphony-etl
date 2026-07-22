import sql from "mssql";
import type { ParsedInvoiceDetail, ParsedInvoiceHeader } from "../../types/micros.js";
import { logger } from "../logger.js";

const SQL_DEBUG = process.env.ETL_DEBUG_SQL === "true";

const logSqlDebug = (message: string, context?: Record<string, unknown>): void => {
  if (!SQL_DEBUG) return;
  logger.info(message, context);
};

const HEADER_MAX_LENGTHS = {
  empresa: 5,
  tienda: 5,
  nit: 32,
  nombre: 128,
  canal: 16,
  uuidFactura: 64,
  indendificador: 250,
  sku: 15,
  descripcion: 128,
  comentario: 4000
} as const;

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

const asBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["1", "true", "yes", "y", "si", "s", "void", "voided", "cancelled", "canceled"].includes(
      normalized
    );
  }
  return false;
};

const truncate = (value: string, maxLength: number): string => value.slice(0, maxLength);

const pickFirstString = (source: Record<string, unknown>, keys: string[], fallback = ""): string => {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value) {
      return value;
    }
  }

  return fallback;
};

const pickFirstNumber = (source: Record<string, unknown>, keys: string[], fallback = 0): number => {
  for (const key of keys) {
    const value = source[key];
    const parsed = asNumber(value, Number.NaN);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return fallback;
};

const pickFirstBoolean = (source: Record<string, unknown>, keys: string[]): boolean =>
  keys.some((key) => asBoolean(source[key]));

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const buildFacturaPosId = (externalId: string): number => {
  const digitsOnly = externalId.replace(/\D/g, "");
  if (digitsOnly) {
    const numericValue = Number(digitsOnly.slice(-9));
    if (Number.isSafeInteger(numericValue) && numericValue > 0) {
      return numericValue;
    }
  }

  let hash = 0;
  for (const character of externalId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 2147483647;
  }

  return hash || 1;
};

const parseBusinessDate = (businessDate: string): Date => {
  const candidate = new Date(`${businessDate}T00:00:00`);
  return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
};

const formatBusinessDate = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
};

export interface FacturaSemanalEntity {
  idFactura?: number;
  empresa: string;
  tienda: string;
  idFacturaPOS: number;
  nit: string;
  nombre: string;
  total: number;
  fechaHora: Date;
  canal: string;
  anulada: boolean;
  contingencia: boolean;
  notaCredito: boolean;
  observaciones: string | null;
  comentario: string | null;
  sincronizado: boolean;
  uuidFactura: string;
  indendificador: string;
}

export interface FacturaDetalleSemanalEntity {
  idFacturaDetalle?: number;
  idFactura: number;
  cantidad: number;
  sku: string;
  descripcion: string | null;
  precio: number;
  total: number;
  descuento: number | null;
}

const mapHeaderToFacturaSemanal = (header: ParsedInvoiceHeader): FacturaSemanalEntity => {
  const rawHeader = header.rawHeader as Record<string, unknown>;

  return {
    empresa: truncate(
      pickFirstString(rawHeader, ["Revenue Center Number", "Company", "Enterprise", "Property", "Property Code"], "00001"),
      HEADER_MAX_LENGTHS.empresa
    ),
    tienda: truncate(
      pickFirstString(rawHeader, ["Revenue Center Number", "Store", "Revenue Center", "Location", "Outlet"], "00095"),
      HEADER_MAX_LENGTHS.tienda
    ),
    idFacturaPOS: pickFirstNumber(rawHeader, ["Check Number", "Invoice Number", "Check ID"], buildFacturaPosId(header.externalId)),
    nit: truncate(
      pickFirstString(rawHeader, ["Employee First Name", "Tax ID", "Taxpayer ID", "Customer Tax ID"], "CF"),
      HEADER_MAX_LENGTHS.nit
    ),
    nombre: truncate(
      pickFirstString(rawHeader, ["Employee Last Name", "Name", "Customer Name", "Guest Name"], "CONSUMIDOR FINAL"),
      HEADER_MAX_LENGTHS.nombre
    ),
    total: roundTo(header.totalAmount, 2),
    fechaHora: parseBusinessDate(header.businessDate),
    canal: truncate(
      pickFirstString(rawHeader, ["Order Channel Name", "Channel", "Order Channel", "Source"], "MICROS"),
      HEADER_MAX_LENGTHS.canal
    ),
    anulada: pickFirstBoolean(rawHeader, ["Auto Closed Flag", "Void", "Voided", "Cancelled", "Canceled"]),
    contingencia: pickFirstBoolean(rawHeader, ["Check Split Flag", "In Contingency"]),
    notaCredito: pickFirstBoolean(rawHeader, ["Reopen Closed Check Flag", "Credit Note"]),
    observaciones: null,
    comentario: null,
    sincronizado: false,
    uuidFactura: truncate(header.externalId, HEADER_MAX_LENGTHS.uuidFactura),
    indendificador: truncate(header.externalId, HEADER_MAX_LENGTHS.indendificador)
  };
};

const mapDetailToFacturaDetalle = (detail: ParsedInvoiceDetail, idFactura: number): FacturaDetalleSemanalEntity => {
  const rawDetail = detail.rawDetail as Record<string, unknown>;
  const quantity = roundTo(detail.quantity, 2);
  const total = roundTo(detail.lineAmount, 2);
  const unitPrice = quantity === 0 ? total : roundTo(total / quantity, 2);
  const discount = pickFirstNumber(rawDetail, ["Discount", "Discount Amount", "Descuento"], Number.NaN);
  const description =
    detail.itemDescription ||
    pickFirstString(rawDetail, ["Description", "Descripcion", "Menu Item Name", "Item Description", "Menu Item"], detail.itemCode);

  return {
    idFactura,
    cantidad: quantity,
    sku: truncate(detail.itemCode || "UNMAPPED_ITEM", HEADER_MAX_LENGTHS.sku),
    descripcion: truncate(description, HEADER_MAX_LENGTHS.descripcion),
    precio: unitPrice,
    total,
    descuento: Number.isNaN(discount) ? null : roundTo(discount, 2)
  };
};

export interface SqlServerConfig {
  user: string;
  password: string;
  server: string;
  database: string;
  options?: sql.config["options"];
}

export interface PendingSale {
  idFactura: number;
  externalId: string;
  businessDate: string;
  totalAmount: number;
  details: Array<{
    lineNumber: number;
    itemCode: string;
    quantity: number;
    lineAmount: number;
  }>;
}

export interface InsertSalesResult {
  insertedHeaders: number;
  skippedHeaders: number;
  insertedDetails: number;
  skippedDetails: number;
}

export class SqlServerClient {
  private pool: sql.ConnectionPool | null = null;

  constructor(private readonly config: SqlServerConfig) {}

  async connect(): Promise<void> {
    if (!this.pool) {
      this.pool = await sql.connect(this.config);
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  async insertSales(headers: ParsedInvoiceHeader[], details: ParsedInvoiceDetail[]): Promise<InsertSalesResult> {
    if (!this.pool) throw new Error("SQL Server connection is not initialized");

    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();

    const stats: InsertSalesResult = {
      insertedHeaders: 0,
      skippedHeaders: 0,
      insertedDetails: 0,
      skippedDetails: 0
    };

    try {
      const headerIdsByExternalId = new Map<string, number>();
      const insertedExternalIds = new Set<string>();

      for (const header of headers) {
        const factura = mapHeaderToFacturaSemanal(header);

        logSqlDebug("Attempting upsert in tFacturaSemanal", {
          externalId: header.externalId,
          indendificador: factura.indendificador,
          total: factura.total,
          fechaHora: factura.fechaHora.toISOString()
        });

        const result = await new sql.Request(transaction)
          .input("empresa", sql.NVarChar(HEADER_MAX_LENGTHS.empresa), factura.empresa)
          .input("tienda", sql.NVarChar(HEADER_MAX_LENGTHS.tienda), factura.tienda)
          .input("idFacturaPOS", sql.Int, factura.idFacturaPOS)
          .input("nit", sql.NVarChar(HEADER_MAX_LENGTHS.nit), factura.nit)
          .input("nombre", sql.NVarChar(HEADER_MAX_LENGTHS.nombre), factura.nombre)
          .input("total", sql.Decimal(10, 2), factura.total)
          .input("fechaHora", sql.DateTime, factura.fechaHora)
          .input("canal", sql.NVarChar(HEADER_MAX_LENGTHS.canal), factura.canal)
          .input("anulada", sql.Bit, factura.anulada)
          .input("contingencia", sql.Bit, factura.contingencia)
          .input("notaCredito", sql.Bit, factura.notaCredito)
          .input("observaciones", sql.NVarChar(sql.MAX), factura.observaciones)
          .input("comentario", sql.NVarChar(HEADER_MAX_LENGTHS.comentario), factura.comentario)
          .input("sincronizado", sql.Bit, factura.sincronizado)
          .input("uuidFactura", sql.NVarChar(HEADER_MAX_LENGTHS.uuidFactura), factura.uuidFactura)
          .input("indendificador", sql.NVarChar(HEADER_MAX_LENGTHS.indendificador), factura.indendificador)
          .query(`
            DECLARE @idFactura INT;
            DECLARE @wasInserted BIT = 0;

            SELECT TOP 1 @idFactura = idFactura
            FROM tFacturaSemanal
            WHERE uuidFactura = @uuidFactura
            ORDER BY idFactura;

            IF @idFactura IS NULL
            BEGIN
              INSERT INTO tFacturaSemanal (
                empresa,
                tienda,
                idFacturaPOS,
                nit,
                nombre,
                total,
                fechaHora,
                canal,
                anulada,
                contingencia,
                notaCredito,
                observaciones,
                comentario,
                sincronizado,
                uuidFactura,
                indendificador
              )
              VALUES (
                @empresa,
                @tienda,
                @idFacturaPOS,
                @nit,
                @nombre,
                @total,
                @fechaHora,
                @canal,
                @anulada,
                @contingencia,
                @notaCredito,
                @observaciones,
                @comentario,
                @sincronizado,
                @uuidFactura,
                @indendificador
              );

              SET @idFactura = SCOPE_IDENTITY();
              SET @wasInserted = 1;
            END
            ELSE
            BEGIN
              UPDATE tFacturaSemanal
              SET uuidFactura = CASE
                WHEN ISNULL(uuidFactura, '') = '' THEN @uuidFactura
                ELSE uuidFactura
              END
              WHERE idFactura = @idFactura;
            END

            SELECT @idFactura AS idFactura, @wasInserted AS wasInserted;
          `);

        const insertedHeader = result.recordset[0] as { idFactura: number; wasInserted: boolean };
        headerIdsByExternalId.set(header.externalId, insertedHeader.idFactura);
        if (insertedHeader.wasInserted) {
          insertedExternalIds.add(header.externalId);
          stats.insertedHeaders += 1;
          // logSqlDebug("Inserted row in tFacturaSemanal", {
          //   idFactura: insertedHeader.idFactura,
          //   indendificador: factura.indendificador,
          //   fechaHora: factura.fechaHora.toISOString(),
          //   total: factura.total,
          //   canal: factura.canal
          // });
        } else {
          stats.skippedHeaders += 1;
          logSqlDebug("Skipped existing row in tFacturaSemanal", {
            idFactura: insertedHeader.idFactura,
            indendificador: factura.indendificador
          });
        }
      }

      for (const detail of details) {
        const parentId = headerIdsByExternalId.get(detail.externalId);

        logSqlDebug("Attempting insert in tFacturaDetalleSemanal", {
          externalId: detail.externalId,
          lineNumber: detail.lineNumber,
          itemCode: detail.itemCode,
          parentId: parentId ?? null
        });

        if (!insertedExternalIds.has(detail.externalId)) {
          stats.skippedDetails += 1;
          logSqlDebug("Skipped row in tFacturaDetalleSemanal", {
            externalId: detail.externalId,
            lineNumber: detail.lineNumber,
            reason: "parent already existed in tFacturaSemanal"
          });
          continue;
        }

        const idFactura = parentId;
        if (!idFactura) {
          throw new Error(`Missing parent invoice for detail with externalId ${detail.externalId}`);
        }

        const facturaDetalle = mapDetailToFacturaDetalle(detail, idFactura);

        await new sql.Request(transaction)
          .input("idFactura", sql.Int, facturaDetalle.idFactura)
          .input("cantidad", sql.Decimal(10, 2), facturaDetalle.cantidad)
          .input("sku", sql.NVarChar(HEADER_MAX_LENGTHS.sku), facturaDetalle.sku)
          .input("descripcion", sql.NVarChar(HEADER_MAX_LENGTHS.descripcion), facturaDetalle.descripcion)
          .input("precio", sql.Decimal(10, 2), facturaDetalle.precio)
          .input("total", sql.Decimal(10, 2), facturaDetalle.total)
          .input("descuento", sql.Decimal(10, 2), facturaDetalle.descuento)
          .query(`
            INSERT INTO tFacturaDetalleSemanal (idFactura, cantidad, sku, descripcion, precio, total, descuento)
            VALUES (@idFactura, @cantidad, @sku, @descripcion, @precio, @total, @descuento)
          `);

        logSqlDebug("Inserted row in tFacturaDetalleSemanal", {
          idFactura: facturaDetalle.idFactura,
          sku: facturaDetalle.sku,
          cantidad: facturaDetalle.cantidad,
          total: facturaDetalle.total
        });
        stats.insertedDetails += 1;
      }

      await transaction.commit();
      return stats;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getPendingSales(limit = 100): Promise<PendingSale[]> {
    if (!this.pool) throw new Error("SQL Server connection is not initialized");

    const pendingHeaders = await this.pool
      .request()
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          idFactura,
          indendificador,
          fechaHora,
          total
        FROM tFacturaSemanal
        WHERE ISNULL(sincronizado, 0) = 0
        ORDER BY idFactura
      `);

    const result: PendingSale[] = pendingHeaders.recordset.map((row) => ({
      idFactura: row.idFactura,
      externalId: row.indendificador,
      businessDate: formatBusinessDate(row.fechaHora),
      totalAmount: Number(row.total),
      details: []
    }));

    if (result.length > 0) {
      const request = this.pool.request();
      const placeholders = result.map((_, index) => `@idFactura${index}`).join(",");

      result.forEach((sale, index) => request.input(`idFactura${index}`, sql.Int, sale.idFactura));

      const detailRows = await request.query(`
        SELECT idFactura, cantidad, sku, total
        FROM tFacturaDetalleSemanal
        WHERE idFactura IN (${placeholders})
        ORDER BY idFactura, idFacturaDetalle
      `);

      const detailsByFacturaId = new Map<number, PendingSale["details"]>();
      for (const detailRow of detailRows.recordset as Array<{
        idFactura: number;
        cantidad: number;
        sku: string;
        total: number;
      }>) {
        const details = detailsByFacturaId.get(detailRow.idFactura) ?? [];
        details.push({
          lineNumber: details.length + 1,
          itemCode: detailRow.sku,
          quantity: Number(detailRow.cantidad),
          lineAmount: Number(detailRow.total)
        });
        detailsByFacturaId.set(detailRow.idFactura, details);
      }

      result.forEach((sale) => {
        sale.details = detailsByFacturaId.get(sale.idFactura) ?? [];
      });
    }

    return result;
  }

  async markSalesAsSynced(ids: number[]): Promise<void> {
    if (!this.pool || ids.length === 0) return;

    const request = this.pool.request();
    const placeholders = ids.map((_, index) => `@id${index}`).join(",");

    ids.forEach((id, index) => request.input(`id${index}`, sql.Int, id));

    await request.query(`
      UPDATE tFacturaSemanal
      SET sincronizado = 1
      WHERE idFactura IN (${placeholders})
    `);
  }
}
