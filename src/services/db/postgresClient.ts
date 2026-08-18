import pg from "pg";
import type { ParsedInvoiceDetail, ParsedInvoiceHeader } from "../../types/micros.js";
import { logger } from "../logger.js";

const POSTGRES_DEBUG = process.env.ETL_DEBUG_POSTGRES === "true" || process.env.ETL_DEBUG_SQL === "true";
const POS_SCHEMA = "pos";

const logPostgresDebug = (message: string, context?: Record<string, unknown>): void => {
  if (!POSTGRES_DEBUG) return;
  logger.info(message, context);
};

const COLUMN_MAX_LENGTHS = {
  empresa: 10,
  tienda: 10,
  nit: 50,
  canal: 50,
  serieFel: 50,
  numeroFel: 50,
  uuidFel: 100,
  dispositivo: 50,
  descripcionPago: 550,
  identificador: 250,
  sku: 50,
  descripcion: 150
} as const;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value.trim() : fallback;

const asNullableString = (value: unknown): string | null => {
  const normalized = asString(value);
  return normalized || null;
};

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

const pickFirstNullableString = (source: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value) {
      return value;
    }
  }

  return null;
};

const pickFirstBoolean = (source: Record<string, unknown>, keys: string[]): boolean =>
  keys.some((key) => asBoolean(source[key]));

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const normalizeBusinessDate = (businessDate: string): string => {
  const normalizedBusinessDate = businessDate.trim();
  const compactDigits = normalizedBusinessDate.replace(/\D/g, "");

  if (compactDigits.length >= 8) {
    return `${compactDigits.slice(0, 4)}-${compactDigits.slice(4, 6)}-${compactDigits.slice(6, 8)}`;
  }

  return formatBusinessDate(normalizedBusinessDate);
};

const formatBusinessDate = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const directMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
    if (directMatch) {
      return `${directMatch[1]}-${directMatch[2]}-${directMatch[3]}`;
    }
  }

  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

interface SaleHeaderEntity {
  codigoEmpresa: string;
  codigoTienda: string;
  serieFel: string | null;
  numeroFel: string | null;
  uuidFel: string | null;
  canalVenta: string;
  nitReceptor: string | null;
  totalConIva: number;
  fechaEmision: string;
  uuidAnulacionFel: string | null;
  fechaAnulacionFel: string | null;
  dispositivo: string | null;
  numeroDocumentoSap: number | null;
  descripcionPago: string | null;
  sincronizado: boolean;
  anulado: boolean;
  identificadorUnicoFel: string;
}

interface StoreLocation {
  empresa: string;
  tienda: string;
  storeNumberSimphony: string;
  enableUploadingDocuments: boolean;
}

export interface StoreSapInventoryConfig {
  empresa: string;
  tienda: string;
  storeNumberSimphony: string;
  warehouseCode: string;
  costingCode: string;
  enableUploadingDocuments: boolean;
}

interface SaleDetailEntity {
  encabezadoVentaId: number;
  cantidad: number;
  sku: string;
  descripcion: string;
  precio: number;
  total: number;
  descuento: number;
}

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslEnabled?: boolean;
  sslRejectUnauthorized?: boolean;
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

export interface PendingSapDocumentLine {
  sku: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface PendingSapDocument {
  businessDate: string;
  empresa: string;
  tienda: string;
  cardCode: string;
  warehouseCode: string;
  externalId: string;
  sourceHeaderIds: number[];
  lines: PendingSapDocumentLine[];
}

export interface InsertSalesResult {
  insertedHeaders: number;
  skippedHeaders: number;
  insertedDetails: number;
  skippedDetails: number;
}

type PgQueryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

const mapHeaderToSaleHeader = (header: ParsedInvoiceHeader, storeLocation: StoreLocation): SaleHeaderEntity => {
  const rawHeader = header.rawHeader as Record<string, unknown>;
  const anulado = pickFirstBoolean(rawHeader, ["Is Void Flag", "Void Flag", "Void", "Voided", "Cancelled", "Canceled"]);

  return {
    codigoEmpresa: truncate(storeLocation.empresa, COLUMN_MAX_LENGTHS.empresa),
    codigoTienda: truncate(storeLocation.tienda, COLUMN_MAX_LENGTHS.tienda),
    serieFel: pickFirstNullableString(rawHeader, ["Serie FEL", "Series", "Invoice Series"]),
    numeroFel: pickFirstNullableString(rawHeader, ["Numero FEL", "Invoice Number"]),
    uuidFel: pickFirstNullableString(rawHeader, ["UUID FEL", "UUID", "FEL UUID"]),
    canalVenta: truncate(
      pickFirstString(rawHeader, ["Order Channel Name", "Channel", "Order Channel", "Source"], "MICROS"),
      COLUMN_MAX_LENGTHS.canal
    ),
    nitReceptor: asNullableString(
      truncate(
        pickFirstString(rawHeader, ["Employee First Name", "Tax ID", "Taxpayer ID", "Customer Tax ID"], "CF"),
        COLUMN_MAX_LENGTHS.nit
      )
    ),
    totalConIva: roundTo(header.totalAmount, 2),
    fechaEmision: normalizeBusinessDate(header.businessDate),
    uuidAnulacionFel: pickFirstNullableString(rawHeader, ["UUID Anulacion FEL", "UUID Cancellation", "Cancellation UUID"]),
    fechaAnulacionFel: anulado ? normalizeBusinessDate(header.businessDate) : null,
    dispositivo: asNullableString(
      truncate(
        pickFirstString(rawHeader, ["Workstation Number", "Terminal Number", "Terminal", "Device", "Workstation"], ""),
        COLUMN_MAX_LENGTHS.dispositivo
      )
    ),
    numeroDocumentoSap: null,
    descripcionPago: asNullableString(
      truncate(
        pickFirstString(
          rawHeader,
          ["Payment Description", "Tender Media Description", "Tender Description", "Payment Method", "Descripcion Pago"],
          ""
        ),
        COLUMN_MAX_LENGTHS.descripcionPago
      )
    ),
    sincronizado: false,
    anulado,
    identificadorUnicoFel: truncate(header.externalId, COLUMN_MAX_LENGTHS.identificador)
  };
};

const mapDetailToSaleDetail = (detail: ParsedInvoiceDetail, encabezadoVentaId: number): SaleDetailEntity => {
  const rawDetail = detail.rawDetail as Record<string, unknown>;
  const quantity = roundTo(detail.quantity, 2);
  const total = roundTo(detail.lineAmount, 2);
  const unitPrice = quantity === 0 ? total : roundTo(total / quantity, 2);
  const discount = asNumber(
    pickFirstString(rawDetail, ["Discount", "Discount Amount", "Descuento"], ""),
    0
  );
  const description =
    detail.itemDescription ||
    pickFirstString(rawDetail, ["Description", "Descripcion", "Menu Item Name", "Item Description", "Menu Item"], detail.itemCode);

  return {
    encabezadoVentaId,
    cantidad: quantity,
    sku: truncate(detail.itemCode || "UNMAPPED_ITEM", COLUMN_MAX_LENGTHS.sku),
    descripcion: truncate(description, COLUMN_MAX_LENGTHS.descripcion),
    precio: unitPrice,
    total,
    descuento: roundTo(discount, 2)
  };
};

export class PostgresClient {
  private pool: pg.Pool | null = null;

  constructor(private readonly config: PostgresConfig) {}

  async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    this.pool = new pg.Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.sslEnabled ? { rejectUnauthorized: this.config.sslRejectUnauthorized !== false } : undefined
    });

    await this.pool.query("SELECT 1");
  }

  async disconnect(): Promise<void> {
    if (!this.pool) {
      return;
    }

    const pool = this.pool;
    this.pool = null;
    await pool.end();
  }

  async insertSales(headers: ParsedInvoiceHeader[], details: ParsedInvoiceDetail[]): Promise<InsertSalesResult> {
    const pool = this.ensurePool();
    const client = await pool.connect();

    const stats: InsertSalesResult = {
      insertedHeaders: 0,
      skippedHeaders: 0,
      insertedDetails: 0,
      skippedDetails: 0
    };

    try {
      await client.query("BEGIN");
      await client.query(`LOCK TABLE ${POS_SCHEMA}.encabezado_venta IN SHARE ROW EXCLUSIVE MODE`);
      await client.query(`LOCK TABLE ${POS_SCHEMA}.detalle_venta IN SHARE ROW EXCLUSIVE MODE`);

      let nextHeaderId = await this.getNextId(client, `${POS_SCHEMA}.encabezado_venta`, "id_encabezado_venta");
      let nextDetailId = await this.getNextId(client, `${POS_SCHEMA}.detalle_venta`, "id_detalle_venta");

      const headerIdsByExternalId = new Map<string, number>();
      const insertedExternalIds = new Set<string>();
      const storeLocationByNumber = new Map<string, StoreLocation | null>();

      for (const header of headers) {
        const storeNumberSimphony = header.storeNumberSimphony.trim();
        let storeLocation = storeLocationByNumber.get(storeNumberSimphony);

        if (!storeLocationByNumber.has(storeNumberSimphony)) {
          storeLocation = storeNumberSimphony ? await this.findStoreLocation(client, storeNumberSimphony) : null;
          storeLocationByNumber.set(storeNumberSimphony, storeLocation);
        }

        if (!storeLocation?.enableUploadingDocuments) {
          stats.skippedHeaders += 1;
          logPostgresDebug("Skipped MICROS header because its store_number_simphony has no tienda match", {
            externalId: header.externalId,
            storeNumberSimphony
          });
          continue;
        }

        const saleHeader = mapHeaderToSaleHeader(header, storeLocation);

        logPostgresDebug("Attempting upsert in encabezado_venta", {
          externalId: header.externalId,
          storeNumberSimphony,
          codigoEmpresa: saleHeader.codigoEmpresa,
          codigoTienda: saleHeader.codigoTienda,
          identificadorUnicoFel: saleHeader.identificadorUnicoFel,
          totalConIva: saleHeader.totalConIva,
          fechaEmision: saleHeader.fechaEmision
        });

        const existingHeaderResult = await client.query<{ id_encabezado_venta: string }>(
          `SELECT id_encabezado_venta
             FROM pos.encabezado_venta
            WHERE identificador_unico_fel = $1
            ORDER BY id_encabezado_venta
            LIMIT 1`,
          [saleHeader.identificadorUnicoFel]
        );

        const existingHeaderId = existingHeaderResult.rows[0]?.id_encabezado_venta;
        if (existingHeaderId) {
          const headerId = Number(existingHeaderId);
          headerIdsByExternalId.set(header.externalId, headerId);
          stats.skippedHeaders += 1;
          logPostgresDebug("Skipped existing row in encabezado_venta", {
            idEncabezadoVenta: headerId,
            identificadorUnicoFel: saleHeader.identificadorUnicoFel
          });
          continue;
        }

        const headerId = nextHeaderId;
        nextHeaderId += 1;

        await client.query(
          `INSERT INTO pos.encabezado_venta (
             id_encabezado_venta,
             codigo_empresa,
             codigo_tienda,
             serie_fel,
             numero_fel,
             uuid_fel,
             canal_venta,
             nit_receptor,
             total_con_iva,
             fecha_emision,
             uuid_anulacion_fel,
             fecha_anulacion_fel,
             dispositivo,
             numero_documento_sap,
             descripcion_pago,
             sincronizado,
             anulado,
             identificador_unico_fel
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18
           )`,
          [
            headerId,
            saleHeader.codigoEmpresa,
            saleHeader.codigoTienda,
            saleHeader.serieFel,
            saleHeader.numeroFel,
            saleHeader.uuidFel,
            saleHeader.canalVenta,
            saleHeader.nitReceptor,
            saleHeader.totalConIva,
            saleHeader.fechaEmision,
            saleHeader.uuidAnulacionFel,
            saleHeader.fechaAnulacionFel,
            saleHeader.dispositivo,
            saleHeader.numeroDocumentoSap,
            saleHeader.descripcionPago,
            saleHeader.sincronizado,
            saleHeader.anulado,
            saleHeader.identificadorUnicoFel
          ]
        );

        headerIdsByExternalId.set(header.externalId, headerId);
        insertedExternalIds.add(header.externalId);
        stats.insertedHeaders += 1;
      }

      for (const detail of details) {
        const parentId = headerIdsByExternalId.get(detail.externalId);

        logPostgresDebug("Attempting insert in detalle_venta", {
          externalId: detail.externalId,
          lineNumber: detail.lineNumber,
          itemCode: detail.itemCode,
          parentId: parentId ?? null
        });

        if (!insertedExternalIds.has(detail.externalId)) {
          stats.skippedDetails += 1;
          logPostgresDebug("Skipped row in detalle_venta", {
            externalId: detail.externalId,
            lineNumber: detail.lineNumber,
            reason: "parent already existed in encabezado_venta"
          });
          continue;
        }

        if (!parentId) {
          throw new Error(`Missing parent sale header for detail with externalId ${detail.externalId}`);
        }

        const saleDetail = mapDetailToSaleDetail(detail, parentId);
        const detailId = nextDetailId;
        nextDetailId += 1;

        await client.query(
          `INSERT INTO pos.detalle_venta (
             id_detalle_venta,
             encabezado_venta_id,
             sku,
             descripcion,
             cantidad,
             precio,
             total,
             descuento
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            detailId,
            saleDetail.encabezadoVentaId,
            saleDetail.sku,
            saleDetail.descripcion,
            saleDetail.cantidad,
            saleDetail.precio,
            saleDetail.total,
            saleDetail.descuento
          ]
        );

        stats.insertedDetails += 1;
      }

      await client.query("COMMIT");
      return stats;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getPendingSales(limit = 100): Promise<PendingSale[]> {
    const pool = this.ensurePool();
    const pendingHeaders = await pool.query<{
      id_encabezado_venta: string;
      identificador_unico_fel: string;
      fecha_emision: string | Date;
      total_con_iva: string;
    }>(
      `SELECT
         id_encabezado_venta,
         identificador_unico_fel,
         fecha_emision,
         total_con_iva
       FROM pos.encabezado_venta
       WHERE COALESCE(sincronizado, FALSE) = FALSE
       ORDER BY id_encabezado_venta
       LIMIT $1`,
      [limit]
    );

    const result: PendingSale[] = pendingHeaders.rows.map((row) => ({
      idFactura: Number(row.id_encabezado_venta),
      externalId: row.identificador_unico_fel,
      businessDate: formatBusinessDate(row.fecha_emision),
      totalAmount: Number(row.total_con_iva),
      details: []
    }));

    if (result.length === 0) {
      return result;
    }

    const detailRows = await pool.query<{
      encabezado_venta_id: string;
      cantidad: string;
      sku: string;
      total: string;
    }>(
      `SELECT encabezado_venta_id, cantidad, sku, total
         FROM pos.detalle_venta
        WHERE encabezado_venta_id = ANY($1::bigint[])
        ORDER BY encabezado_venta_id, id_detalle_venta`,
      [result.map((sale) => sale.idFactura)]
    );

    const detailsByFacturaId = new Map<number, PendingSale["details"]>();
    for (const detailRow of detailRows.rows) {
      const facturaId = Number(detailRow.encabezado_venta_id);
      const existingDetails = detailsByFacturaId.get(facturaId) ?? [];
      existingDetails.push({
        lineNumber: existingDetails.length + 1,
        itemCode: detailRow.sku,
        quantity: Number(detailRow.cantidad),
        lineAmount: Number(detailRow.total)
      });
      detailsByFacturaId.set(facturaId, existingDetails);
    }

    result.forEach((sale) => {
      sale.details = detailsByFacturaId.get(sale.idFactura) ?? [];
    });

    return result;
  }

  async getPendingSapDocumentsByDateRange(startDate: string, endDate: string): Promise<PendingSapDocument[]> {
    const pool = this.ensurePool();
    const headerRows = await pool.query<{
      id_encabezado_venta: string;
      business_date: string | Date;
      codigo_empresa: string;
      codigo_tienda: string;
      codigo_cliente_sap: string | null;
      codigo_almacen_sap: string | null;
    }>(
      `SELECT
         ev.id_encabezado_venta,
         ev.fecha_emision AS business_date,
         ev.codigo_empresa,
         ev.codigo_tienda,
         t.codigo_cliente_sap,
         t.codigo_almacen_sap
       FROM pos.encabezado_venta AS ev
       INNER JOIN pos.tienda AS t
         ON t.codigo_empresa = ev.codigo_empresa
        AND t.codigo_tienda = ev.codigo_tienda
       WHERE ev.fecha_emision BETWEEN $1::date AND $2::date
         AND ev.numero_documento_sap IS NULL
         AND COALESCE(ev.anulado, FALSE) = FALSE
         AND NULLIF(BTRIM(t.store_number_simphony), '') IS NOT NULL
       ORDER BY ev.id_encabezado_venta`,
      [startDate, endDate]
    );

    const groupedDocuments = new Map<string, PendingSapDocument>();

    for (const row of headerRows.rows) {
      const cardCode = asString(row.codigo_cliente_sap);
      const warehouseCode = asString(row.codigo_almacen_sap);

      if (!cardCode || !warehouseCode) {
        throw new Error(
          `Missing codigo_cliente_sap/codigo_almacen_sap in tienda for empresa ${row.codigo_empresa} and tienda ${row.codigo_tienda} (id_encabezado_venta ${row.id_encabezado_venta})`
        );
      }

      const businessDate = formatBusinessDate(row.business_date);
      const groupKey = `${businessDate}|${row.codigo_empresa}|${row.codigo_tienda}`;
      const existing = groupedDocuments.get(groupKey);

      if (existing) {
        existing.sourceHeaderIds.push(Number(row.id_encabezado_venta));
      } else {
        groupedDocuments.set(groupKey, {
          businessDate,
          empresa: row.codigo_empresa,
          tienda: row.codigo_tienda,
          cardCode,
          warehouseCode,
          externalId: `MICROS-${businessDate}-${row.codigo_empresa}-${row.codigo_tienda}`,
          sourceHeaderIds: [Number(row.id_encabezado_venta)],
          lines: []
        });
      }
    }

    const pendingDocuments = Array.from(groupedDocuments.values());
    for (const document of pendingDocuments) {
      const detailRows = await pool.query<{
        sku: string;
        precio: string;
        quantity: string;
        line_total: string;
      }>(
        `SELECT
           sku,
           precio,
           SUM(cantidad) AS quantity,
           SUM(total) AS line_total
         FROM pos.detalle_venta
         WHERE encabezado_venta_id = ANY($1::bigint[])
           AND precio > 0
           AND cantidad > 0
         GROUP BY sku, precio
         ORDER BY sku, precio`,
        [document.sourceHeaderIds]
      );

      document.lines = detailRows.rows.map((row) => ({
        sku: asString(row.sku),
        quantity: roundTo(Number(row.quantity), 2),
        unitPrice: roundTo(Number(row.precio), 2),
        lineTotal: roundTo(Number(row.line_total), 2)
      }));
    }

    return pendingDocuments.filter((document) => document.lines.length > 0);
  }

  async getPendingSapDocumentsForToday(): Promise<PendingSapDocument[]> {
    const today = formatBusinessDate(new Date());
    return this.getPendingSapDocumentsByDateRange(today, today);
  }

  async markSapDocumentNumber(ids: number[], docNum: number): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const pool = this.ensurePool();
    await pool.query(
      `UPDATE pos.encabezado_venta
          SET numero_documento_sap = $1,
              sincronizado = TRUE
        WHERE id_encabezado_venta = ANY($2::bigint[])`,
      [docNum, ids]
    );
  }

  async markSalesAsSynced(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const pool = this.ensurePool();
    await pool.query(
      `UPDATE pos.encabezado_venta
          SET sincronizado = TRUE
        WHERE id_encabezado_venta = ANY($1::bigint[])`,
      [ids]
    );
  }

  /**
   * Deletes existing rows for the given serie+numero and bulk-inserts all lines.
   * Returns the number of rows inserted.
   */
  async upsertSalidaInventario(
    serieTicket: string,
    numeroTicket: number,
    codigoEmpresa: string,
    codigoTienda: string,
    nombreTienda: string,
    fechaSalida: string,
    fechaHoraIngreso: string,
    lines: Array<{
      codigoProducto: string;
      descripcionProducto: string;
      unidadMedida: string;
      cantidadSalida: number;
      codigoPrimitivoProducto: string;
      precioUnitario: number;
    }>
  ): Promise<number> {
    if (lines.length === 0) return 0;

    const pool = this.ensurePool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `DELETE FROM pos.salida_inventario
          WHERE serie_ticket = $1 AND numero_ticket = $2`,
        [serieTicket, numeroTicket]
      );

      const rowValues: unknown[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;

      for (const line of lines) {
        placeholders.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
          `$${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
          `$${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
        );
        rowValues.push(
          serieTicket,
          numeroTicket,
          codigoEmpresa,
          codigoTienda,
          nombreTienda,
          fechaSalida,
          fechaHoraIngreso,
          // numero_documento_sap → NULL on insert
          null,
          line.codigoProducto,
          line.descripcionProducto,
          line.unidadMedida,
          line.cantidadSalida,
          line.codigoPrimitivoProducto,
          line.precioUnitario
        );
      }

      await client.query(
        `INSERT INTO pos.salida_inventario (
          serie_ticket, numero_ticket, codigo_empresa, codigo_tienda, nombre_tienda,
          fecha_salida, fecha_hora_ingreso,
          numero_documento_sap,
          codigo_producto, descripcion_producto, unidad_medida, cantidad_salida,
          codigo_primitivo_producto, precio_unitario
        ) VALUES ${placeholders.join(", ")}`,
        rowValues
      );

      await client.query("COMMIT");
      return lines.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Updates numero_documento_sap for all rows of a given serie+numero after SAP confirms the document.
   */
  async updateSalidaInventarioDocNum(
    serieTicket: string,
    numeroTicket: number,
    numeroDocumentoSap: number
  ): Promise<void> {
    const pool = this.ensurePool();
    await pool.query(
      `UPDATE pos.salida_inventario
          SET numero_documento_sap = $3
        WHERE serie_ticket = $1 AND numero_ticket = $2`,
      [serieTicket, numeroTicket, numeroDocumentoSap]
    );
  }

  /**
   * Deletes existing rows for the given serie+numero and bulk-inserts all lines.
   * Returns the number of rows inserted.
   */
  async upsertEntradaMercancia(
    serieTicket: string,
    numeroTicket: number,
    codigoEmpresa: string,
    codigoTienda: string,
    fechaEntrada: string,
    lines: Array<{
      skuProducto: string;
      descripcionProducto: string;
      unidadMedida: string;
      cantidad: number;
      precioUnitario: number;
    }>
  ): Promise<number> {
    if (lines.length === 0) return 0;

    const pool = this.ensurePool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `DELETE FROM pos.entrada_mercancia
          WHERE serie_ticket = $1 AND numero_ticket = $2`,
        [serieTicket, numeroTicket]
      );

      const rowValues: unknown[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;

      for (const line of lines) {
        placeholders.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
          `$${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
          `$${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
        );
        rowValues.push(
          serieTicket,
          numeroTicket,
          codigoEmpresa,
          codigoTienda,
          fechaEntrada,
          // numero_documento_sap → NULL on insert
          null,
          line.skuProducto,
          line.descripcionProducto,
          line.unidadMedida,
          line.cantidad,
          // producto equivalente = same values as entrada (by design)
          line.skuProducto,
          line.descripcionProducto,
          line.unidadMedida,
          line.unidadMedida,
          line.precioUnitario
        );
      }

      await client.query(
        `INSERT INTO pos.entrada_mercancia (
          serie_ticket, numero_ticket, codigo_empresa, codigo_tienda, fecha_entrada,
          numero_documento_sap,
          sku_producto_entrada, descripcion_producto_entrada, unidad_medida_entrada, cantidad_entrada,
          sku_producto_equivalente, descripcion_producto_equivalente, unidad_medida_equivalente,
          unidad_paquete_equivalente, precio_unitario_equivalente
        ) VALUES ${placeholders.join(", ")}`,
        rowValues
      );

      await client.query("COMMIT");
      return lines.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Updates numero_documento_sap for all rows of a given serie+numero after SAP confirms the document.
   */
  async updateEntradaMercanciaDocNum(
    serieTicket: string,
    numeroTicket: number,
    numeroDocumentoSap: number
  ): Promise<void> {
    const pool = this.ensurePool();
    await pool.query(
      `UPDATE pos.entrada_mercancia
          SET numero_documento_sap = $3
        WHERE serie_ticket = $1 AND numero_ticket = $2`,
      [serieTicket, numeroTicket, numeroDocumentoSap]
    );
  }

  async getStoreSapInventoryConfigBySimphonyStoreNumber(storeNumberSimphony: string): Promise<StoreSapInventoryConfig | null> {
    const normalizedStoreNumber = storeNumberSimphony.trim();
    if (!normalizedStoreNumber) {
      return null;
    }

    const pool = this.ensurePool();
    const result = await pool.query<{
      codigo_empresa: string;
      codigo_tienda: string;
      store_number_simphony: string;
      codigo_almacen_sap: string | null;
      codigo_centro_costo_sap: string | null;
    }>(
      `SELECT
         codigo_empresa,
         codigo_tienda,
         store_number_simphony,
         codigo_almacen_sap,
         codigo_centro_costo_sap
       FROM pos.tienda
       WHERE store_number_simphony = $1
       ORDER BY id_tienda
       LIMIT 1`,
      [normalizedStoreNumber]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      empresa: row.codigo_empresa,
      tienda: row.codigo_tienda,
      storeNumberSimphony: row.store_number_simphony,
      warehouseCode: asString(row.codigo_almacen_sap),
      costingCode: asString(row.codigo_centro_costo_sap),
      enableUploadingDocuments: true
    };
  }

  private ensurePool(): pg.Pool {
    if (!this.pool) {
      throw new Error("PostgreSQL connection is not initialized");
    }

    return this.pool;
  }

  private async getNextId(client: pg.PoolClient, tableName: string, columnName: string): Promise<number> {
    const result = await client.query<{ next_id: string }>(
      `SELECT COALESCE(MAX(${columnName}), 0) + 1 AS next_id FROM ${tableName}`
    );
    return Number(result.rows[0]?.next_id ?? 1);
  }

  private async findStoreLocation(queryable: PgQueryable, storeNumberSimphony: string): Promise<StoreLocation | null> {
    const result = await queryable.query<{
      codigo_empresa: string;
      codigo_tienda: string;
      store_number_simphony: string;
    }>(
      `SELECT
         codigo_empresa,
         codigo_tienda,
         store_number_simphony
       FROM pos.tienda
       WHERE store_number_simphony = $1
       ORDER BY id_tienda
       LIMIT 1`,
      [storeNumberSimphony]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      empresa: row.codigo_empresa,
      tienda: row.codigo_tienda,
      storeNumberSimphony: row.store_number_simphony,
      enableUploadingDocuments: true
    };
  }
}
