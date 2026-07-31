import pg from "pg";

export interface MiddlewareDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslEnabled?: boolean;
  sslRejectUnauthorized?: boolean;
}

export interface SftpFileEventResult {
  status: "ingested" | "failed";
  headersParsed: number;
  detailsParsed: number;
  insertedHeaders: number;
  skippedHeaders: number;
  insertedDetails: number;
  skippedDetails: number;
  movedToOk: boolean;
  errorMessage?: string;
}

export interface SapDocumentEventInput {
  businessDate: string;
  empresa: string;
  tienda: string;
  cardCode: string | null;
  warehouseCode: string | null;
  externalId: string | null;
  sourceHeaderCount: number;
  sourceLineCount: number;
  mappedLineCount: number;
  skippedLineCount: number;
  status: "posted" | "skipped" | "failed";
  docNum?: number | null;
  docEntry?: number | null;
  errorMessage?: string | null;
}

export interface PedidoFileEventResult {
  status: "uploaded" | "failed";
  apiSuccess: boolean;
  totalPedidos: number;
  pedidosSuccess: number;
  pedidosFailed: number;
  movedToOk: boolean;
  responsePayload?: unknown;
  errorMessage?: string;
}

export class MiddlewareDbClient {
  private readonly pool: pg.Pool;

  constructor(config: MiddlewareDbConfig) {
    const sslEnabled = config.sslEnabled !== false;

    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: sslEnabled
        ? { rejectUnauthorized: config.sslRejectUnauthorized !== false }
        : undefined
    });
  }

  async createRun(params: {
    jobType: "sftp_ingest" | "sap_sync" | "full_integration" | "pedido_upload";
    triggerMode: "cron" | "manual";
    dateRangeStart?: string;
    dateRangeEnd?: string;
    triggeredBy?: string;
  }): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO etl.integration_run
         (job_type, trigger_mode, date_range_start, date_range_end, triggered_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        params.jobType,
        params.triggerMode,
        params.dateRangeStart ?? null,
        params.dateRangeEnd ?? null,
        params.triggeredBy ?? null,
      ]
    );
    return Number(result.rows[0].id);
  }

  async finishRun(runId: number, status: "success" | "failed", errorMessage?: string): Promise<void> {
    await this.pool.query(
      `UPDATE etl.integration_run
       SET status = $1, finished_at = NOW(), error_message = $2
       WHERE id = $3`,
      [status, errorMessage ?? null, runId]
    );
  }

  async openSftpFileEvent(
    runId: number,
    fileName: string,
    remotePath: string | null,
    businessDate: string | null
  ): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO etl.sftp_file_event (run_id, file_name, remote_path, business_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [runId, fileName, remotePath, businessDate]
    );
    return Number(result.rows[0].id);
  }

  async closeSftpFileEvent(id: number, result: SftpFileEventResult): Promise<void> {
    await this.pool.query(
      `UPDATE etl.sftp_file_event
       SET status           = $1,
           headers_parsed   = $2,
           details_parsed   = $3,
           inserted_headers = $4,
           skipped_headers  = $5,
           inserted_details = $6,
           skipped_details  = $7,
           moved_to_ok      = $8,
           error_message    = $9
       WHERE id = $10`,
      [
        result.status,
        result.headersParsed,
        result.detailsParsed,
        result.insertedHeaders,
        result.skippedHeaders,
        result.insertedDetails,
        result.skippedDetails,
        result.movedToOk,
        result.errorMessage ?? null,
        id,
      ]
    );
  }

  async openPedidoFileEvent(
    runId: number,
    fileName: string,
    remotePath: string | null
  ): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO etl.pedido_file_event (run_id, file_name, remote_path)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [runId, fileName, remotePath]
    );
    return Number(result.rows[0].id);
  }

  async closePedidoFileEvent(id: number, result: PedidoFileEventResult): Promise<void> {
    await this.pool.query(
      `UPDATE etl.pedido_file_event
       SET status           = $1,
           api_success      = $2,
           total_pedidos    = $3,
           pedidos_success  = $4,
           pedidos_failed   = $5,
           moved_to_ok      = $6,
           response_payload = $7,
           error_message    = $8
       WHERE id = $9`,
      [
        result.status,
        result.apiSuccess,
        result.totalPedidos,
        result.pedidosSuccess,
        result.pedidosFailed,
        result.movedToOk,
        result.responsePayload ? JSON.stringify(result.responsePayload) : null,
        result.errorMessage ?? null,
        id
      ]
    );
  }

  async insertSapDocumentEvent(runId: number, input: SapDocumentEventInput): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO etl.sap_document_event
         (run_id, business_date, empresa, tienda, card_code, warehouse_code, external_id,
          source_header_count, source_line_count, mapped_line_count, skipped_line_count,
          status, doc_num, doc_entry, error_message, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               CASE WHEN $12 = 'posted'::etl.doc_status THEN NOW() ELSE NULL END)
       RETURNING id`,
      [
        runId,
        input.businessDate,
        input.empresa,
        input.tienda,
        input.cardCode,
        input.warehouseCode,
        input.externalId,
        input.sourceHeaderCount,
        input.sourceLineCount,
        input.mappedLineCount,
        input.skippedLineCount,
        input.status,
        input.docNum ?? null,
        input.docEntry ?? null,
        input.errorMessage ?? null,
      ]
    );
    return Number(result.rows[0].id);
  }

  async insertSkuMappingMiss(
    runId: number,
    sapDocumentEventId: number,
    businessDate: string,
    empresa: string,
    tienda: string,
    sku: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO etl.sku_mapping_miss
         (run_id, sap_document_event_id, business_date, empresa, tienda, sku)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, sapDocumentEventId, businessDate, empresa, tienda, sku]
    );
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }
}
