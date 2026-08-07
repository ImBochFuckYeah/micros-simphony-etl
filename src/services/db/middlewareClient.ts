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

export interface ConsumoFileEventResult {
  status: "uploaded" | "failed";
  sapSuccess: boolean;
  totalLines: number;
  uploadedLines: number;
  skippedLines: number;
  movedToOk: boolean;
  sapDocNum?: number;
  sapDocEntry?: number;
  storeNumber?: string;
  businessDate?: string;
  responsePayload?: unknown;
  errorMessage?: string;
}

export interface SapDeliveryInput {
  externalId: string;
  businessDate: string;
  empresa: string;
  tienda: string;
  sourceHeaderIds: number[];
  payloadHash: string;
}

export interface SapDelivery {
  id: number;
  status: "pending" | "sending" | "confirmed" | "failed" | "manual_intervention_required";
  attempts: number;
  payloadHash: string;
  sapDocNum: number | null;
  sapDocEntry: number | null;
}

export interface PedidoDelivery {
  id: number;
  status: "pending" | "sending" | "confirmed" | "failed" | "manual_intervention_required";
  attempts: number;
}

export interface ConsumoDelivery {
  id: number;
  status: "pending" | "sending" | "confirmed" | "failed" | "manual_intervention_required";
  attempts: number;
  payloadHash: string;
  sapDocNum: number | null;
  sapDocEntry: number | null;
}

export interface JobSchedule {
  id: number;
  name: string;
  jobType: "sftp_ingest" | "sap_sync" | "full_integration" | "pedido_upload" | "consumo_upload";
  cronExpression: string;
  timezone: string;
}

export class MiddlewareDbClient {
  private readonly pool: pg.Pool;
  private lockClient: pg.PoolClient | null = null;

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
    jobType: "sftp_ingest" | "sap_sync" | "full_integration" | "pedido_upload" | "consumo_upload";
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

  async getEnabledJobSchedules(): Promise<JobSchedule[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      job_type: JobSchedule["jobType"];
      cron_expression: string;
      timezone: string;
    }>(
      `SELECT id, name, job_type, cron_expression, timezone
       FROM ops.job_schedule
       WHERE enabled = TRUE
       ORDER BY id`
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      jobType: row.job_type,
      cronExpression: row.cron_expression,
      timezone: row.timezone
    }));
  }

  async tryAcquireJobLock(jobName: string): Promise<boolean> {
    if (this.lockClient) {
      throw new Error("A job lock is already held by this middleware database client");
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [jobName]
      );
      const acquired = result.rows[0]?.acquired === true;

      if (!acquired) {
        client.release();
        return false;
      }

      this.lockClient = client;
      return true;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async releaseJobLock(): Promise<void> {
    if (!this.lockClient) return;

    const client = this.lockClient;
    this.lockClient = null;
    try {
      await client.query("SELECT pg_advisory_unlock_all()");
    } finally {
      client.release();
    }
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

  async getOrCreatePedidoDelivery(fileName: string, remotePath: string | null): Promise<PedidoDelivery> {
    const result = await this.pool.query<{
      id: string;
      status: PedidoDelivery["status"];
      attempts: number;
    }>(
      `INSERT INTO etl.pedido_file_delivery (file_name, remote_path)
       VALUES ($1, $2)
       ON CONFLICT (file_name) DO UPDATE SET remote_path = EXCLUDED.remote_path, updated_at = NOW()
       RETURNING id, status, attempts`,
      [fileName, remotePath]
    );
    const row = result.rows[0];
    return { id: Number(row.id), status: row.status, attempts: row.attempts };
  }

  async markPedidoDeliverySending(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE etl.pedido_file_delivery
       SET status = 'sending', attempts = attempts + 1, updated_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [id]
    );
  }

  async recordPedidoDeliveryResult(
    deliveryId: number,
    result: {
      numeroPedido?: string;
      externalId?: string;
      estado?: string;
      totalLineas?: number;
      success: boolean;
      errorMessage?: string;
      responsePayload: unknown;
    }
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO etl.pedido_delivery_result
         (pedido_delivery_id, numero_pedido, external_id, estado, total_lineas, success, error_message, response_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        deliveryId,
        result.numeroPedido ?? null,
        result.externalId ?? null,
        result.estado ?? null,
        result.totalLineas ?? null,
        result.success,
        result.errorMessage ?? null,
        JSON.stringify(result.responsePayload)
      ]
    );
  }

  async confirmPedidoDelivery(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE etl.pedido_file_delivery
       SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [id]
    );
  }

  async failPedidoDelivery(id: number, errorMessage: string, requiresManualIntervention: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE etl.pedido_file_delivery
       SET status = CASE WHEN $3 THEN 'manual_intervention_required' ELSE 'failed' END,
           last_error = $2, next_attempt_at = CASE WHEN $3 THEN NULL ELSE NOW() + INTERVAL '5 minutes' END,
           updated_at = NOW()
       WHERE id = $1`,
      [id, errorMessage, requiresManualIntervention]
    );
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

  async openConsumoFileEvent(
    runId: number,
    fileName: string,
    remotePath: string | null
  ): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO etl.consumo_file_event (run_id, file_name, remote_path)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [runId, fileName, remotePath]
    );
    return Number(result.rows[0].id);
  }

  async getOrCreateConsumoDelivery(
    fileName: string,
    remotePath: string | null,
    payloadHash: string
  ): Promise<ConsumoDelivery> {
    const result = await this.pool.query<{
      id: string;
      status: ConsumoDelivery["status"];
      attempts: number;
      payload_hash: string;
      sap_doc_num: number | null;
      sap_doc_entry: number | null;
    }>(
      `INSERT INTO etl.consumo_file_delivery (file_name, remote_path, payload_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (file_name) DO UPDATE SET remote_path = EXCLUDED.remote_path, updated_at = NOW()
       RETURNING id, status, attempts, payload_hash, sap_doc_num, sap_doc_entry`,
      [fileName, remotePath, payloadHash]
    );
    const row = result.rows[0];

    return {
      id: Number(row.id),
      status: row.status,
      attempts: row.attempts,
      payloadHash: row.payload_hash,
      sapDocNum: row.sap_doc_num,
      sapDocEntry: row.sap_doc_entry
    };
  }

  async markConsumoDeliverySending(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE etl.consumo_file_delivery
       SET status = 'sending', attempts = attempts + 1, updated_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [id]
    );
  }

  async confirmConsumoDelivery(id: number, docNum: number, docEntry: number): Promise<void> {
    await this.pool.query(
      `UPDATE etl.consumo_file_delivery
       SET status = 'confirmed', sap_doc_num = $2, sap_doc_entry = $3,
           confirmed_at = NOW(), updated_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [id, docNum, docEntry]
    );
  }

  async failConsumoDelivery(id: number, errorMessage: string, requiresManualIntervention: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE etl.consumo_file_delivery
       SET status = CASE WHEN $3 THEN 'manual_intervention_required' ELSE 'failed' END,
           last_error = $2, next_attempt_at = CASE WHEN $3 THEN NULL ELSE NOW() + INTERVAL '5 minutes' END,
           updated_at = NOW()
       WHERE id = $1`,
      [id, errorMessage, requiresManualIntervention]
    );
  }

  async closeConsumoFileEvent(id: number, result: ConsumoFileEventResult): Promise<void> {
    await this.pool.query(
      `UPDATE etl.consumo_file_event
       SET status           = $1,
           sap_success      = $2,
           total_lines      = $3,
           uploaded_lines   = $4,
           skipped_lines    = $5,
           moved_to_ok      = $6,
           sap_doc_num      = $7,
           sap_doc_entry    = $8,
           store_number     = $9,
           business_date    = $10,
           response_payload = $11,
           error_message    = $12
       WHERE id = $13`,
      [
        result.status,
        result.sapSuccess,
        result.totalLines,
        result.uploadedLines,
        result.skippedLines,
        result.movedToOk,
        result.sapDocNum ?? null,
        result.sapDocEntry ?? null,
        result.storeNumber ?? null,
        result.businessDate ?? null,
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

  async getOrCreateSapDelivery(input: SapDeliveryInput): Promise<SapDelivery> {
    const result = await this.pool.query<{
      id: string;
      status: SapDelivery["status"];
      attempts: number;
      payload_hash: string;
      sap_doc_num: number | null;
      sap_doc_entry: number | null;
    }>(
      `INSERT INTO etl.sap_delivery
         (external_id, business_date, empresa, tienda, source_header_ids, payload_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (external_id) DO UPDATE SET updated_at = NOW()
       RETURNING id, status, attempts, payload_hash, sap_doc_num, sap_doc_entry`,
      [
        input.externalId,
        input.businessDate,
        input.empresa,
        input.tienda,
        JSON.stringify(input.sourceHeaderIds),
        input.payloadHash
      ]
    );
    const row = result.rows[0];

    return {
      id: Number(row.id),
      status: row.status,
      attempts: row.attempts,
      payloadHash: row.payload_hash,
      sapDocNum: row.sap_doc_num,
      sapDocEntry: row.sap_doc_entry
    };
  }

  async markSapDeliverySending(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE etl.sap_delivery
       SET status = 'sending', attempts = attempts + 1, updated_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [id]
    );
  }

  async confirmSapDelivery(id: number, docNum: number, docEntry: number): Promise<void> {
    await this.pool.query(
      `UPDATE etl.sap_delivery
       SET status = 'confirmed', sap_doc_num = $2, sap_doc_entry = $3,
           confirmed_at = NOW(), updated_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [id, docNum, docEntry]
    );
  }

  async failSapDelivery(id: number, errorMessage: string, requiresManualIntervention: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE etl.sap_delivery
       SET status = CASE WHEN $3 THEN 'manual_intervention_required' ELSE 'failed' END,
           last_error = $2, next_attempt_at = CASE WHEN $3 THEN NULL ELSE NOW() + INTERVAL '5 minutes' END,
           updated_at = NOW()
       WHERE id = $1`,
      [id, errorMessage, requiresManualIntervention]
    );
  }

  async openAlert(input: {
    severity: "warning" | "error";
    category: string;
    deduplicationKey: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ops.alert_event (severity, category, deduplication_key, message, context)
       VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (deduplication_key, status)
       DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message,
                     context = EXCLUDED.context, created_at = NOW()`,
      [
        input.severity,
        input.category,
        input.deduplicationKey,
        input.message,
        JSON.stringify(input.context ?? {})
      ]
    );
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
    await this.releaseJobLock();
    await this.pool.end();
  }
}
