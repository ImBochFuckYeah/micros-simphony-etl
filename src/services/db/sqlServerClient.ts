import sql from "mssql";
import type { ParsedInvoiceDetail, ParsedInvoiceHeader } from "../../types/micros.js";

export interface SqlServerConfig {
  user: string;
  password: string;
  server: string;
  database: string;
  options?: sql.config["options"];
}

export interface PendingSale {
  idFacturaSemanal: number;
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

  async insertSales(headers: ParsedInvoiceHeader[], details: ParsedInvoiceDetail[]): Promise<void> {
    if (!this.pool) throw new Error("SQL Server connection is not initialized");

    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();

    try {
      for (const header of headers) {
        await new sql.Request(transaction)
          .input("externalId", sql.VarChar(100), header.externalId)
          .input("businessDate", sql.VarChar(20), header.businessDate)
          .input("totalAmount", sql.Decimal(18, 2), header.totalAmount)
          .input("rawHeader", sql.NVarChar(sql.MAX), JSON.stringify(header.rawHeader))
          .query(`
            INSERT INTO tFacturaSemanal (ExternalId, BusinessDate, TotalAmount, RawHeaderJson, SyncStatus)
            VALUES (@externalId, @businessDate, @totalAmount, @rawHeader, 'PENDING')
          `);
      }

      for (const detail of details) {
        await new sql.Request(transaction)
          .input("externalId", sql.VarChar(100), detail.externalId)
          .input("lineNumber", sql.Int, detail.lineNumber)
          .input("itemCode", sql.VarChar(100), detail.itemCode)
          .input("quantity", sql.Decimal(18, 4), detail.quantity)
          .input("lineAmount", sql.Decimal(18, 2), detail.lineAmount)
          .input("rawDetail", sql.NVarChar(sql.MAX), JSON.stringify(detail.rawDetail))
          .query(`
            INSERT INTO tFacturaDetalleSemanal (ExternalId, LineNumber, ItemCode, Quantity, LineAmount, RawDetailJson)
            VALUES (@externalId, @lineNumber, @itemCode, @quantity, @lineAmount, @rawDetail)
          `);
      }

      await transaction.commit();
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
          IdFacturaSemanal,
          ExternalId,
          BusinessDate,
          TotalAmount
        FROM tFacturaSemanal
        WHERE SyncStatus = 'PENDING'
        ORDER BY IdFacturaSemanal
      `);

    const result: PendingSale[] = pendingHeaders.recordset.map((row) => ({
      idFacturaSemanal: row.IdFacturaSemanal,
      externalId: row.ExternalId,
      businessDate: row.BusinessDate,
      totalAmount: Number(row.TotalAmount),
      details: []
    }));

    if (result.length > 0) {
      const request = this.pool.request();
      const placeholders = result.map((_, index) => `@externalId${index}`).join(",");

      result.forEach((sale, index) => request.input(`externalId${index}`, sql.VarChar(100), sale.externalId));

      const detailRows = await request.query(`
        SELECT ExternalId, LineNumber, ItemCode, Quantity, LineAmount
        FROM tFacturaDetalleSemanal
        WHERE ExternalId IN (${placeholders})
        ORDER BY ExternalId, LineNumber
      `);

      const detailsByExternalId = new Map<string, PendingSale["details"]>();
      for (const detailRow of detailRows.recordset as Array<{
        ExternalId: string;
        LineNumber: number;
        ItemCode: string;
        Quantity: number;
        LineAmount: number;
      }>) {
        const details = detailsByExternalId.get(detailRow.ExternalId) ?? [];
        details.push({
          lineNumber: detailRow.LineNumber,
          itemCode: detailRow.ItemCode,
          quantity: Number(detailRow.Quantity),
          lineAmount: Number(detailRow.LineAmount)
        });
        detailsByExternalId.set(detailRow.ExternalId, details);
      }

      result.forEach((sale) => {
        sale.details = detailsByExternalId.get(sale.externalId) ?? [];
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
      SET SyncStatus = 'SYNCED', SyncedAt = SYSUTCDATETIME()
      WHERE IdFacturaSemanal IN (${placeholders})
    `);
  }
}
