import fs from "node:fs/promises";
import cron from "node-cron";
import { appConfig } from "../config/env.js";
import { SqlServerClient } from "../services/db/sqlServerClient.js";
import { logger, startLoggerInactivityWatchdog, stopLoggerInactivityWatchdog } from "../services/logger.js";
import { parseMicrosSales } from "../services/micros/microsParser.js";
import {
  PedidoApiClient,
  type PedidoUploadResponse,
  type PedidoUploadResultadoArchivo
} from "../services/pedidos/pedidoApiClient.js";
import { SapServiceLayerClient, type SapSalePayload } from "../services/sap/sapServiceLayerClient.js";
import { MicrosSftpService, type MicrosExportDateRange } from "../services/sftp/sftpClient.js";
import { MiddlewareDbClient } from "../services/db/middlewareClient.js";
import type { MicrosJsonExport, ParsedInvoiceHeader, ParsedInvoiceDetail } from "../types/micros.js";

interface ProcessingDateRange {
  startDate: string;
  endDate: string;
}

interface PedidoUploadOutcome {
  fileSuccess: boolean;
  totalPedidos: number;
  pedidosSuccess: number;
  pedidosFailed: number;
  fileResult?: PedidoUploadResultadoArchivo;
}

const formatDateOnly = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseDateInput = (value: string | Date): Date => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("Invalid date value provided");
    }

    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid date format '${value}'. Expected YYYY-MM-DD`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new Error(`Invalid date value '${value}'`);
  }

  return parsed;
};

const resolveProcessingDateRange = (
  startDateInput?: string | Date,
  endDateInput?: string | Date
): ProcessingDateRange => {
  const today = new Date();
  const start = startDateInput ? parseDateInput(startDateInput) : new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = endDateInput ? parseDateInput(endDateInput) : start;

  if (end < start) {
    throw new Error("endDate must be greater than or equal to startDate");
  }

  return {
    startDate: formatDateOnly(start),
    endDate: formatDateOnly(end)
  };
};

const extractBusinessDateFromFileName = (fileName: string): string | null => {
  const match = /_(\d{2})(\d{2})(\d{2})_N\.json$/i.exec(fileName);
  if (!match) return null;
  return `20${match[3]}-${match[2]}-${match[1]}`;
};

const mapConsolidatedDocumentToSapPayload = (
  document: {
    cardCode: string;
    warehouseCode: string;
    businessDate: string;
    externalId: string;
    lines: Array<{ itemCode: string; quantity: number; unitPrice: number; lineTotal: number }>;
  },
  empresa: string,
  tienda: string
): SapSalePayload => ({
  CardCode: document.cardCode,
  Series: appConfig.sapInvoiceSeries,
  U_MICROS_ExternalId: document.externalId,
  DocDate: document.businessDate,
  DocDueDate: document.businessDate,
  ReserveInvoice: 'tYES',
  Comments: `MICROS consolidated sale ${document.businessDate} ${empresa}/${tienda}`,
  DocumentLines: document.lines.map((line) => ({
    ItemCode: line.itemCode,
    Quantity: line.quantity,
    PriceAfterVAT: line.unitPrice,
    WarehouseCode: document.warehouseCode
  }))
});

const resolvePedidoUploadOutcome = (
  response: PedidoUploadResponse,
  fileName: string
): PedidoUploadOutcome => {
  const fileResult = response.resultados?.find((result) => result.archivo === fileName) ?? response.resultados?.[0];

  if (!fileResult) {
    return {
      fileSuccess: response.success === true,
      totalPedidos: 0,
      pedidosSuccess: 0,
      pedidosFailed: 0,
    };
  }

  const pedidos = fileResult.pedidos ?? [];
  const pedidosSuccess = pedidos.filter((pedido) => pedido.success).length;
  const fileSuccess = pedidos.length > 0 && pedidosSuccess === pedidos.length;

  return {
    fileSuccess,
    totalPedidos: pedidos.length,
    pedidosSuccess,
    pedidosFailed: pedidos.length - pedidosSuccess,
    fileResult
  };
};

const ingestMicrosExports = async (
  sftpService: MicrosSftpService,
  sqlServerClient: SqlServerClient,
  middlewareClient: MiddlewareDbClient,
  runId: number,
  range: MicrosExportDateRange
): Promise<void> => {
  const downloadedFiles = await sftpService.downloadNewMicrosExports(range);
  logger.info("SFTP export files downloaded", {
    count: downloadedFiles.length,
    startDate: range.startDate,
    endDate: range.endDate
  });

  for (const downloadedFile of downloadedFiles) {
    const fileEventId = await middlewareClient.openSftpFileEvent(
      runId,
      downloadedFile.fileName,
      downloadedFile.remotePath,
      extractBusinessDateFromFileName(downloadedFile.fileName)
    );

    let headers: ParsedInvoiceHeader[] = [];
    let details: ParsedInvoiceDetail[] = [];
    let insertStats = { insertedHeaders: 0, skippedHeaders: 0, insertedDetails: 0, skippedDetails: 0 };
    let movedToOk = false;

    try {
      const content = await fs.readFile(downloadedFile.localPath, "utf-8");
      const microsJson = JSON.parse(content) as MicrosJsonExport;
      ({ headers, details } = parseMicrosSales(microsJson));
      logger.info("SFTP file parsed", {
        filePath: downloadedFile.localPath,
        headers: headers.length,
        details: details.length
      });

      if (headers.length > 0) {
        insertStats = await sqlServerClient.insertSales(headers, details);
        logger.info("SQL upsert summary for file", {
          filePath: downloadedFile.localPath,
          ...insertStats
        });
      } else {
        logger.info("SFTP file contained no sales records", {
          filePath: downloadedFile.localPath,
          fileName: downloadedFile.fileName
        });
      }

      await sftpService.moveMicrosExportToOk(downloadedFile.fileName);
      movedToOk = true;
      logger.info("SFTP file moved to OK", {
        fileName: downloadedFile.fileName,
        remotePath: downloadedFile.remotePath
      });

      await fs.rm(downloadedFile.localPath, { force: true });
      logger.info("Local downloaded file deleted", {
        filePath: downloadedFile.localPath
      });

      await middlewareClient.closeSftpFileEvent(fileEventId, {
        status: "ingested",
        headersParsed: headers.length,
        detailsParsed: details.length,
        ...insertStats,
        movedToOk
      });
    } catch (error) {
      await middlewareClient.closeSftpFileEvent(fileEventId, {
        status: "failed",
        headersParsed: headers.length,
        detailsParsed: details.length,
        ...insertStats,
        movedToOk,
        errorMessage: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
      throw error;
    }
  }
};

const syncPendingSalesToSap = async (
  sqlServerClient: SqlServerClient,
  sapClient: SapServiceLayerClient,
  middlewareClient: MiddlewareDbClient,
  runId: number,
  range: ProcessingDateRange
): Promise<void> => {
  const pendingDocuments = await sqlServerClient.getPendingSapDocumentsByDateRange(range.startDate, range.endDate);
  logger.info("Pending consolidated sales loaded for SAP sync", {
    count: pendingDocuments.length,
    startDate: range.startDate,
    endDate: range.endDate
  });

  if (pendingDocuments.length === 0) {
    return;
  }

  const itemsBySimphonyId = await sapClient.getSalesItemsBySimphonyId();
  logger.info("SAP items catalog loaded for MICROS mapping", { count: itemsBySimphonyId.size });

  for (const document of pendingDocuments) {
    const skippedSkus: string[] = [];
    const mappedLines: Array<{ itemCode: string; quantity: number; unitPrice: number; lineTotal: number }> = [];

    for (const line of document.lines) {
      const normalizedSku = line.sku.trim();
      logger.info("Mapping MICROS sku to SAP item code", {
        sku: normalizedSku,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal
      });

      const itemCode = itemsBySimphonyId.get(normalizedSku);
      if (!itemCode) {
        if (appConfig.strictSapItemMapping) {
          throw new Error(
            `No SAP ItemCode found for MICROS sku ${normalizedSku} (U_ID_SIMPHONY) in ${document.businessDate} ${document.empresa}/${document.tienda}`
          );
        }

        skippedSkus.push(normalizedSku);
        continue;
      }

      mappedLines.push({
        itemCode,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal
      });
    }

    logger.info("SAP line mapping summary", {
      businessDate: document.businessDate,
      empresa: document.empresa,
      tienda: document.tienda,
      sourceLineCount: document.lines.length,
      mappedLineCount: mappedLines.length,
      skippedLineCount: skippedSkus.length
    });

    if (skippedSkus.length > 0) {
      logger.info("SAP SKU mapping missing, lines skipped", {
        businessDate: document.businessDate,
        empresa: document.empresa,
        tienda: document.tienda,
        skippedSkus
      });
    }

    if (mappedLines.length === 0) {
      logger.info("Consolidated sale skipped because all SKUs are unmapped in SAP", {
        businessDate: document.businessDate,
        empresa: document.empresa,
        tienda: document.tienda,
        sourceHeaderCount: document.sourceHeaderIds.length
      });

      const skippedDocEventId = await middlewareClient.insertSapDocumentEvent(runId, {
        businessDate: document.businessDate,
        empresa: document.empresa,
        tienda: document.tienda,
        cardCode: document.cardCode,
        warehouseCode: document.warehouseCode,
        externalId: document.externalId,
        sourceHeaderCount: document.sourceHeaderIds.length,
        sourceLineCount: document.lines.length,
        mappedLineCount: 0,
        skippedLineCount: skippedSkus.length,
        status: "skipped"
      });
      for (const sku of skippedSkus) {
        await middlewareClient.insertSkuMappingMiss(runId, skippedDocEventId, document.businessDate, document.empresa, document.tienda, sku);
      }
      continue;
    }

    const payload = mapConsolidatedDocumentToSapPayload(
      {
        cardCode: document.cardCode,
        warehouseCode: document.warehouseCode,
        businessDate: document.businessDate,
        externalId: document.externalId,
        lines: mappedLines
      },
      document.empresa,
      document.tienda
    );

    try {
      const posted = await sapClient.postSale(payload);
      await sqlServerClient.markSapDocumentNumber(document.sourceHeaderIds, posted.DocNum);
      logger.info("Consolidated sale synced to SAP", {
        businessDate: document.businessDate,
        empresa: document.empresa,
        tienda: document.tienda,
        sourceHeaderCount: document.sourceHeaderIds.length,
        docNum: posted.DocNum,
        docEntry: posted.DocEntry
      });

      const postedDocEventId = await middlewareClient.insertSapDocumentEvent(runId, {
        businessDate: document.businessDate,
        empresa: document.empresa,
        tienda: document.tienda,
        cardCode: document.cardCode,
        warehouseCode: document.warehouseCode,
        externalId: document.externalId,
        sourceHeaderCount: document.sourceHeaderIds.length,
        sourceLineCount: document.lines.length,
        mappedLineCount: mappedLines.length,
        skippedLineCount: skippedSkus.length,
        status: "posted",
        docNum: posted.DocNum,
        docEntry: posted.DocEntry
      });
      for (const sku of skippedSkus) {
        await middlewareClient.insertSkuMappingMiss(runId, postedDocEventId, document.businessDate, document.empresa, document.tienda, sku);
      }
    } catch (error) {
      await middlewareClient.insertSapDocumentEvent(runId, {
        businessDate: document.businessDate,
        empresa: document.empresa,
        tienda: document.tienda,
        cardCode: document.cardCode,
        warehouseCode: document.warehouseCode,
        externalId: document.externalId,
        sourceHeaderCount: document.sourceHeaderIds.length,
        sourceLineCount: document.lines.length,
        mappedLineCount: mappedLines.length,
        skippedLineCount: skippedSkus.length,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
      throw error;
    }
  }
};

const processPedidoFiles = async (
  sftpService: MicrosSftpService,
  pedidoApiClient: PedidoApiClient,
  middlewareClient: MiddlewareDbClient,
  runId: number,
  range: ProcessingDateRange
): Promise<void> => {
  const downloadedFiles = await sftpService.downloadPedidoFiles({ startDate: range.startDate, endDate: range.endDate });
  logger.info("SFTP PEDIDOS files downloaded", { count: downloadedFiles.length });

  for (const downloadedFile of downloadedFiles) {
    const fileEventId = await middlewareClient.openPedidoFileEvent(
      runId,
      downloadedFile.fileName,
      downloadedFile.remotePath
    );

    let movedToOk = false;
    let apiSuccess = false;
    let totalPedidos = 0;
    let pedidosSuccess = 0;
    let pedidosFailed = 0;
    let responsePayload: PedidoUploadResponse | null = null;

    try {
      responsePayload = await pedidoApiClient.uploadFile(downloadedFile.localPath, downloadedFile.fileName);
      const outcome = resolvePedidoUploadOutcome(responsePayload, downloadedFile.fileName);
      apiSuccess = outcome.fileSuccess;
      totalPedidos = outcome.totalPedidos;
      pedidosSuccess = outcome.pedidosSuccess;
      pedidosFailed = outcome.pedidosFailed;

      logger.info("PEDIDOS API file upload response", {
        fileName: downloadedFile.fileName,
        apiSuccess,
        totalPedidos,
        pedidosSuccess,
        pedidosFailed,
      });

      if (!apiSuccess) {
        throw new Error(
          `PEDIDOS API reported file failure for ${downloadedFile.fileName}: ${JSON.stringify(outcome.fileResult ?? responsePayload)}`
        );
      }

      await sftpService.movePedidoFileToOk(downloadedFile.fileName);
      movedToOk = true;
      logger.info("SFTP PEDIDOS file moved to OK", {
        fileName: downloadedFile.fileName,
        remotePath: downloadedFile.remotePath
      });

      await fs.rm(downloadedFile.localPath, { force: true });
      logger.info("Local PEDIDOS file deleted", {
        filePath: downloadedFile.localPath
      });

      await middlewareClient.closePedidoFileEvent(fileEventId, {
        status: "uploaded",
        apiSuccess,
        totalPedidos,
        pedidosSuccess,
        pedidosFailed,
        movedToOk,
        responsePayload: responsePayload
      });
    } catch (error) {
      logger.error("PEDIDOS file processing failed", {
        fileName: downloadedFile.fileName,
        remotePath: downloadedFile.remotePath,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error
      });

      await middlewareClient.closePedidoFileEvent(fileEventId, {
        status: "failed",
        apiSuccess,
        totalPedidos,
        pedidosSuccess,
        pedidosFailed,
        movedToOk,
        responsePayload: responsePayload ?? undefined,
        errorMessage: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
    }
  }
};

export const processPendingInvoicesInSapOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);
  const sapClient = new SapServiceLayerClient(appConfig.sap);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  const runId = await middlewareClient.createRun({
    jobType: "sap_sync",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-sap-sync");
  await sqlServerClient.connect();

  try {
    await syncPendingSalesToSap(sqlServerClient, sapClient, middlewareClient, runId, range);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await sqlServerClient.disconnect();
      await middlewareClient.disconnect().catch(() => {});
    }
  }
};

export const processMicrosFilesOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  const runId = await middlewareClient.createRun({
    jobType: "sftp_ingest",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-sync");
  await sqlServerClient.connect();

  try {
    await ingestMicrosExports(sftpService, sqlServerClient, middlewareClient, runId, range);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    await sqlServerClient.disconnect();
    await middlewareClient.disconnect().catch(() => {});
  }
};

export const runFullIntegrationOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);
  const sapClient = new SapServiceLayerClient(appConfig.sap);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  const runId = await middlewareClient.createRun({
    jobType: "full_integration",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-full-sync");
  await sqlServerClient.connect();

  try {
    await ingestMicrosExports(sftpService, sqlServerClient, middlewareClient, runId, range);
    await syncPendingSalesToSap(sqlServerClient, sapClient, middlewareClient, runId, range);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await sqlServerClient.disconnect();
      await middlewareClient.disconnect().catch(() => {});
    }
  }
};

export const processPedidosFilesOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const pedidoApiClient = new PedidoApiClient(appConfig.pedidosApi);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  const runId = await middlewareClient.createRun({
    jobType: "pedido_upload",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-pedido-sync");

  try {
    await processPedidoFiles(sftpService, pedidoApiClient, middlewareClient, runId, range);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    await middlewareClient.disconnect().catch(() => {});
  }
};

export const startNightlySyncJob = (): void => {
  cron.schedule(
    appConfig.cronExpression,
    async () => {
      try {
        await processPendingInvoicesInSapOnce(undefined, undefined, "cron");
      } catch (error) {
        logger.error("Nightly SAP invoice processing failed", {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error
        });
      }

      try {
        await processPedidosFilesOnce(undefined, undefined, "cron");
      } catch (error) {
        logger.error("Nightly PEDIDOS processing failed", {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error
        });
      }
    },
    {
      timezone: appConfig.cronTimezone
    }
  );
};
