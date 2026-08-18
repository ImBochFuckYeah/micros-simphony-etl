import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import cron from "node-cron";
import { appConfig } from "../config/env.js";
import { PostgresClient } from "../services/db/postgresClient.js";
import { logger, startLoggerInactivityWatchdog, stopLoggerInactivityWatchdog } from "../services/logger.js";
import { parseMicrosInventoryConsumptions, parseMicrosInventoryConsumptionsEnriched } from "../services/micros/consumoParser.js";
import { parseMicrosInventoryEntries } from "../services/micros/entradaParser.js";
import { parseMicrosSales } from "../services/micros/microsParser.js";
import {
  PedidoApiClient,
  type PedidoUploadResponse,
  type PedidoUploadResultadoArchivo
} from "../services/pedidos/pedidoApiClient.js";
import {
  SapServiceLayerClient,
  type SapInventoryEntryPayload,
  type SapInventoryExitPayload,
  type SapSalePayload
} from "../services/sap/sapServiceLayerClient.js";
import {
  MicrosSftpService,
  parseInventoryMovementFileDate,
  resolveInventoryFlowPaths,
  type DownloadedMicrosExport,
  type MicrosExportDateRange
} from "../services/sftp/sftpClient.js";
import { MiddlewareDbClient, type JobSchedule } from "../services/db/middlewareClient.js";
import type { ConsumoJsonExport } from "../types/consumos.js";
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

const MAX_SAP_DELIVERY_ATTEMPTS = 3;
const MAX_PEDIDO_DELIVERY_ATTEMPTS = 3;
const MAX_CONSUMO_DELIVERY_ATTEMPTS = 3;
const MAX_ENTRADA_DELIVERY_ATTEMPTS = 3;
const DEFAULT_JOB_LOCK_NAME = "micros_simphony_etl";
const PEDIDOS_JOB_LOCK_NAME = "micros_simphony_etl_pedidos";

const hashPayload = (payload: unknown): string =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

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

const isFileDateWithinRange = (fileDate: Date, range: ProcessingDateRange): boolean => {
  const parsedStart = parseDateInput(range.startDate);
  const parsedEnd = parseDateInput(range.endDate);
  const candidate = new Date(fileDate.getFullYear(), fileDate.getMonth(), fileDate.getDate());
  return candidate >= parsedStart && candidate <= parsedEnd;
};

const listLocalDownloadedFiles = async (params: {
  localDir: string;
  remoteDir: string;
  range: ProcessingDateRange;
  parseFileDate: (fileName: string) => Date | null;
  flowName: string;
}): Promise<DownloadedMicrosExport[]> => {
  await fs.mkdir(params.localDir, { recursive: true });
  const directoryEntries = await fs.readdir(params.localDir, { withFileTypes: true });

  const files = directoryEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => {
      const fileDate = params.parseFileDate(fileName);
      return fileDate ? isFileDateWithinRange(fileDate, params.range) : false;
    })
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => ({
      fileName,
      localPath: path.join(params.localDir, fileName),
      remotePath: path.posix.join(params.remoteDir, fileName)
    }));

  logger.info(`${params.flowName} local files loaded for operation`, {
    localDir: params.localDir,
    remoteDir: params.remoteDir,
    count: files.length
  });

  return files;
};

const listLocalDownloadedPedidoFiles = async (params: {
  localDir: string;
  remoteDir: string;
}): Promise<DownloadedMicrosExport[]> => {
  await fs.mkdir(params.localDir, { recursive: true });
  const directoryEntries = await fs.readdir(params.localDir, { withFileTypes: true });

  const files = directoryEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => /\.txt$/i.test(fileName))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => ({
      fileName,
      localPath: path.join(params.localDir, fileName),
      remotePath: path.posix.join(params.remoteDir, fileName)
    }));

  logger.info("PEDIDOS local files loaded for operation", {
    localDir: params.localDir,
    remoteDir: params.remoteDir,
    count: files.length
  });

  return files;
};

const resolvePedidosFlowPaths = (): { localDir: string; remoteDir: string } => ({
  localDir: appConfig.sftp.pedidosLocalDir,
  remoteDir: appConfig.sftp.pedidosRemoteDir ?? path.posix.join(appConfig.sftp.remoteDir, "PEDIDOS")
});

const resolveConsumosFlowPaths = (): { localDir: string; remoteDir: string } => ({
  localDir: appConfig.sftp.consumosLocalDir,
  remoteDir: appConfig.sftp.consumosRemoteDir ?? path.posix.join(appConfig.sftp.remoteDir, "CONSUMOS")
});

const resolveEntradasFlowPaths = (): { localDir: string; remoteDir: string } => {
  const resolved = resolveInventoryFlowPaths(appConfig.sftp);
  return {
    localDir: resolved.entradasLocalDir,
    remoteDir: resolved.entradasRemoteDir
  };
};

const extractBusinessDateFromFileName = (fileName: string): string | null => {
  const match = /_(\d{2})(\d{2})(\d{2})_N\.json$/i.exec(fileName);
  if (!match) return null;
  return `20${match[3]}-${match[2]}-${match[1]}`;
};

const buildConsumoExternalId = (fileName: string, storeNumber: string, firstBusinessDate: string): string =>
  `CONSUMO-${storeNumber}-${firstBusinessDate.replace(/-/g, "")}-${fileName.replace(/\.[^.]+$/i, "")}`;

const buildEntradaExternalId = (fileName: string, storeNumber: string, firstBusinessDate: string): string =>
  `ENTRADA-${storeNumber}-${firstBusinessDate.replace(/-/g, "")}-${fileName.replace(/\.[^.]+$/i, "")}`;

const mapConsumoToSapInventoryExitPayload = (
  input: {
    externalId: string;
    businessDate: string;
    fileName: string;
    storeNumber: string;
    warehouseCode: string;
    costingCode: string;
    lines: Array<{ itemCode: string; quantity: number }>;
  }
): SapInventoryExitPayload => ({
  U_MICROS_ExternalId: input.externalId,
  DocDate: input.businessDate,
  Comments: `MICROS consumo ${input.businessDate} ${input.storeNumber} (${input.fileName})`,
  DocumentLines: input.lines.map((line) => ({
    ItemCode: line.itemCode,
    Quantity: line.quantity,
    WarehouseCode: input.warehouseCode,
    CostingCode: input.costingCode
  }))
});

const mapEntradaToSapInventoryEntryPayload = (
  input: {
    externalId: string;
    businessDate: string;
    fileName: string;
    storeNumber: string;
    warehouseCode: string;
    lines: Array<{ itemCode: string; quantity: number }>;
  }
): SapInventoryEntryPayload => ({
  U_MICROS_ExternalId: input.externalId,
  DocDate: input.businessDate,
  Comments: `MICROS entrada ${input.businessDate} ${input.storeNumber} (${input.fileName})`,
  DocumentLines: input.lines.map((line) => ({
    ItemCode: line.itemCode,
    Quantity: line.quantity,
    WarehouseCode: input.warehouseCode
  }))
});

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

const hasPedidoValidationError = (outcome: PedidoUploadOutcome): boolean =>
  outcome.fileResult?.pedidos?.some(
    (pedido) => !pedido.success && pedido.error?.trim().toLowerCase() === "validation error"
  ) ?? false;

const ingestMicrosExports = async (
  sftpService: MicrosSftpService,
  postgresClient: PostgresClient,
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
        insertStats = await postgresClient.insertSales(headers, details);
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
  postgresClient: PostgresClient,
  sapClient: SapServiceLayerClient,
  middlewareClient: MiddlewareDbClient,
  runId: number,
  range: ProcessingDateRange
): Promise<void> => {
  const pendingDocuments = await postgresClient.getPendingSapDocumentsByDateRange(range.startDate, range.endDate);
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

    if (skippedSkus.length > 0) {
      logger.info("Consolidated sale blocked because one or more SKUs are unmapped in SAP", {
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
      await middlewareClient.openAlert({
        severity: "warning",
        category: "unmapped_sku",
        deduplicationKey: `unmapped_sku:${document.businessDate}:${document.empresa}:${document.tienda}`,
        message: `SAP document blocked because ${skippedSkus.length} SKU mappings are missing`,
        context: { businessDate: document.businessDate, empresa: document.empresa, tienda: document.tienda, skippedSkus }
      });
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
    const delivery = await middlewareClient.getOrCreateSapDelivery({
      externalId: document.externalId,
      businessDate: document.businessDate,
      empresa: document.empresa,
      tienda: document.tienda,
      sourceHeaderIds: document.sourceHeaderIds,
      payloadHash: hashPayload(payload)
    });

    if (delivery.payloadHash !== hashPayload(payload)) {
      const errorMessage = `Payload changed for existing SAP delivery ${document.externalId}`;
      await middlewareClient.failSapDelivery(delivery.id, errorMessage, true);
      await middlewareClient.openAlert({
        severity: "error",
        category: "sap_delivery_payload_changed",
        deduplicationKey: `sap_delivery_payload_changed:${document.externalId}`,
        message: errorMessage,
        context: { externalId: document.externalId }
      });
      continue;
    }

    if (delivery.status === "manual_intervention_required") {
      logger.info("SAP delivery skipped because it requires manual intervention", {
        externalId: document.externalId,
        attempts: delivery.attempts
      });
      continue;
    }

    if (delivery.status === "confirmed" && delivery.sapDocNum !== null && delivery.sapDocEntry !== null) {
      await postgresClient.markSapDocumentNumber(document.sourceHeaderIds, delivery.sapDocNum);
      continue;
    }

    if (delivery.attempts >= MAX_SAP_DELIVERY_ATTEMPTS) {
      const errorMessage = `SAP delivery exhausted ${MAX_SAP_DELIVERY_ATTEMPTS} attempts`;
      await middlewareClient.failSapDelivery(delivery.id, errorMessage, true);
      await middlewareClient.openAlert({
        severity: "error",
        category: "sap_delivery_failed",
        deduplicationKey: `sap_delivery_failed:${document.externalId}`,
        message: errorMessage,
        context: { externalId: document.externalId, attempts: delivery.attempts }
      });
      continue;
    }

    try {
      await middlewareClient.markSapDeliverySending(delivery.id);
      const existingDocument = await sapClient.findSaleByExternalId(document.externalId);
      const posted = existingDocument ?? await sapClient.postSale(payload);
      await postgresClient.markSapDocumentNumber(document.sourceHeaderIds, posted.DocNum);
      await middlewareClient.confirmSapDelivery(delivery.id, posted.DocNum, posted.DocEntry);
      logger.info("Consolidated sale synced to SAP", {
        businessDate: document.businessDate,
        empresa: document.empresa,
        tienda: document.tienda,
        sourceHeaderCount: document.sourceHeaderIds.length,
        docNum: posted.DocNum,
        docEntry: posted.DocEntry,
        recoveredExistingDocument: Boolean(existingDocument)
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const requiresManualIntervention = delivery.attempts + 1 >= MAX_SAP_DELIVERY_ATTEMPTS;
      await middlewareClient.failSapDelivery(delivery.id, errorMessage, requiresManualIntervention).catch(() => {});
      if (requiresManualIntervention) {
        await middlewareClient.openAlert({
          severity: "error",
          category: "sap_delivery_failed",
          deduplicationKey: `sap_delivery_failed:${document.externalId}`,
          message: `SAP delivery exhausted ${MAX_SAP_DELIVERY_ATTEMPTS} attempts: ${errorMessage}`,
          context: { externalId: document.externalId, attempts: delivery.attempts + 1 }
        }).catch(() => {});
      }
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
        errorMessage
      }).catch(() => {});
    }
  }
};

const processPedidoFiles = async (
  sftpService: MicrosSftpService,
  pedidoApiClient: PedidoApiClient,
  middlewareClient: MiddlewareDbClient,
  runId: number,
  options?: { downloadedFiles?: DownloadedMicrosExport[] }
): Promise<void> => {
  const downloadedFiles = options?.downloadedFiles
    ?? await sftpService.downloadPedidoFiles();
  logger.info("PEDIDOS files ready for operation", {
    count: downloadedFiles.length,
    source: options?.downloadedFiles ? "local" : "sftp"
  });

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
    let deliveryConfirmed = false;
    const delivery = await middlewareClient.getOrCreatePedidoDelivery(
      downloadedFile.fileName,
      downloadedFile.remotePath
    );
    const isManualInterventionRequired = delivery.status === "manual_intervention_required";

    try {
      if (delivery.status === "confirmed") {
        apiSuccess = true;
        deliveryConfirmed = true;
      } else {
        if (isManualInterventionRequired) {
          logger.info("PEDIDOS delivery retrying manual-intervention file", {
            fileName: downloadedFile.fileName,
            attempts: delivery.attempts
          });
        }

        if (delivery.attempts >= MAX_PEDIDO_DELIVERY_ATTEMPTS && !isManualInterventionRequired) {
          const errorMessage = `PEDIDOS delivery exhausted ${MAX_PEDIDO_DELIVERY_ATTEMPTS} attempts`;
          await middlewareClient.failPedidoDelivery(delivery.id, errorMessage, true);
          await middlewareClient.openAlert({
            severity: "error",
            category: "pedido_delivery_failed",
            deduplicationKey: `pedido_delivery_failed:${downloadedFile.fileName}`,
            message: errorMessage,
            context: { fileName: downloadedFile.fileName, attempts: delivery.attempts }
          });
          await middlewareClient.closePedidoFileEvent(fileEventId, {
            status: "failed",
            apiSuccess,
            totalPedidos,
            pedidosSuccess,
            pedidosFailed,
            movedToOk,
            errorMessage
          });
          continue;
        }

        await middlewareClient.markPedidoDeliverySending(delivery.id);
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

        for (const pedido of outcome.fileResult?.pedidos ?? []) {
          await middlewareClient.recordPedidoDeliveryResult(delivery.id, {
            numeroPedido: pedido.numero_pedido,
            externalId: pedido.id_pedido,
            estado: pedido.estado,
            totalLineas: pedido.total_lineas,
            success: pedido.success,
            errorMessage: pedido.error,
            responsePayload: pedido
          });
        }

      if (!apiSuccess) {
          const errorMessage =
          `PEDIDOS API reported file failure for ${downloadedFile.fileName}: ${JSON.stringify(outcome.fileResult ?? responsePayload)}`
          const requiresManualIntervention = hasPedidoValidationError(outcome);
          await middlewareClient.failPedidoDelivery(delivery.id, errorMessage, requiresManualIntervention);
          if (requiresManualIntervention) {
            await middlewareClient.openAlert({
              severity: "warning",
              category: "pedido_validation_or_duplicate",
              deduplicationKey: `pedido_validation_or_duplicate:${downloadedFile.fileName}`,
              message: errorMessage,
              context: { fileName: downloadedFile.fileName, responsePayload }
            });
          }
          await middlewareClient.closePedidoFileEvent(fileEventId, {
            status: "failed",
            apiSuccess,
            totalPedidos,
            pedidosSuccess,
            pedidosFailed,
            movedToOk,
            responsePayload,
            errorMessage
          });
          continue;
        }

        await middlewareClient.confirmPedidoDelivery(delivery.id);
        deliveryConfirmed = true;
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const requiresManualIntervention = delivery.attempts + 1 >= MAX_PEDIDO_DELIVERY_ATTEMPTS;
      logger.error("PEDIDOS file processing failed", {
        fileName: downloadedFile.fileName,
        remotePath: downloadedFile.remotePath,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error
      });

      if (!deliveryConfirmed) {
        await middlewareClient.failPedidoDelivery(delivery.id, errorMessage, requiresManualIntervention).catch(() => {});
      }
      if (requiresManualIntervention && !deliveryConfirmed) {
        await middlewareClient.openAlert({
          severity: "error",
          category: "pedido_delivery_failed",
          deduplicationKey: `pedido_delivery_failed:${downloadedFile.fileName}`,
          message: `PEDIDOS delivery exhausted ${MAX_PEDIDO_DELIVERY_ATTEMPTS} attempts: ${errorMessage}`,
          context: { fileName: downloadedFile.fileName, attempts: delivery.attempts + 1 }
        }).catch(() => {});
      }

      await middlewareClient.closePedidoFileEvent(fileEventId, {
        status: "failed",
        apiSuccess,
        totalPedidos,
        pedidosSuccess,
        pedidosFailed,
        movedToOk,
        responsePayload: responsePayload ?? undefined,
        errorMessage
      }).catch(() => {});
    }
  }
};

const processConsumoFiles = async (
  sftpService: MicrosSftpService,
  postgresClient: PostgresClient,
  sapClient: SapServiceLayerClient,
  middlewareClient: MiddlewareDbClient,
  runId: number,
  range: ProcessingDateRange,
  options?: { moveToOk?: boolean; downloadedFiles?: DownloadedMicrosExport[] }
): Promise<string[]> => {
  const shouldMoveToOk = options?.moveToOk ?? true;
  const processedFiles: string[] = [];
  const downloadedFiles = options?.downloadedFiles
    ?? await sftpService.downloadConsumoFiles({ startDate: range.startDate, endDate: range.endDate });
  logger.info("CONSUMOS files ready for operation", {
    count: downloadedFiles.length,
    source: options?.downloadedFiles ? "local" : "sftp"
  });

  for (const downloadedFile of downloadedFiles) {
    const fileEventId = await middlewareClient.openConsumoFileEvent(
      runId,
      downloadedFile.fileName,
      downloadedFile.remotePath
    );

    let movedToOk = false;
    let sapSuccess = false;
    let totalLines = 0;
    let uploadedLines = 0;
    let skippedLines = 0;
    let sapDocNum: number | undefined;
    let sapDocEntry: number | undefined;
    let storeNumber = "";
    let businessDate = "";
    let deliveryAttempt: { id: number; attempts: number } | null = null;
    let localFileDeleted = false;

    try {
      const content = await fs.readFile(downloadedFile.localPath, "utf-8");
      const consumoJson = JSON.parse(content) as ConsumoJsonExport;
      const parsedConsumo = parseMicrosInventoryConsumptions(consumoJson);
      const parsedConsumoEnriched = parseMicrosInventoryConsumptionsEnriched(consumoJson);
      storeNumber = parsedConsumo.storeNumber;
      businessDate = parsedConsumo.firstBusinessDate;

      logger.info("CONSUMOS file parsed", {
        fileName: downloadedFile.fileName,
        storeNumber,
        businessDate,
        rawLineCount: parsedConsumo.lines.length
      });

      const storeConfig = await postgresClient.getStoreSapInventoryConfigBySimphonyStoreNumber(storeNumber);
      if (!storeConfig || !storeConfig.enableUploadingDocuments) {
        const errorMessage = `Store ${storeNumber} is not enabled for SAP inventory upload`;
        logger.info("CONSUMOS file skipped before SAP upload", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          reason: errorMessage
        });
        await middlewareClient.openAlert({
          severity: "warning",
          category: "consumo_store_mapping_missing",
          deduplicationKey: `consumo_store_mapping_missing:${storeNumber}`,
          message: errorMessage,
          context: { storeNumber, fileName: downloadedFile.fileName }
        });
        await middlewareClient.closeConsumoFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          errorMessage
        });
        continue;
      }

      if (!storeConfig.warehouseCode || !storeConfig.costingCode) {
        const errorMessage = `Store ${storeNumber} is missing codigo_almacen_sap/codigo_centro_costo_sap in tienda`;
        logger.info("CONSUMOS file skipped before SAP upload", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          reason: errorMessage
        });
        await middlewareClient.openAlert({
          severity: "error",
          category: "consumo_store_mapping_missing",
          deduplicationKey: `consumo_store_mapping_missing:${storeNumber}`,
          message: errorMessage,
          context: { storeNumber, fileName: downloadedFile.fileName }
        });
        await middlewareClient.closeConsumoFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          errorMessage
        });
        continue;
      }

      const groupedLines = new Map<string, number>();
      for (const line of parsedConsumo.lines) {
        const current = groupedLines.get(line.itemCode) ?? 0;
        groupedLines.set(line.itemCode, current + line.quantity);
      }

      totalLines = parsedConsumo.lines.length;
      const uploadableLines = Array.from(groupedLines.entries())
        .map(([itemCode, quantity]) => ({ itemCode, quantity }))
        .filter((line) => line.quantity > 0);

      uploadedLines = uploadableLines.length;
      skippedLines = Math.max(totalLines - uploadedLines, 0);

      logger.info("CONSUMOS line aggregation summary", {
        fileName: downloadedFile.fileName,
        storeNumber,
        businessDate,
        totalLines,
        uploadedLines,
        skippedLines
      });

      if (uploadableLines.length === 0) {
        const errorMessage = `CONSUMOS file ${downloadedFile.fileName} has no valid lines to upload`;
        logger.info("CONSUMOS file skipped before SAP upload", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          totalLines,
          uploadedLines,
          skippedLines,
          reason: errorMessage
        });
        await middlewareClient.closeConsumoFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          errorMessage
        });
        continue;
      }

      // Persist enriched parsed lines to pos.salida_inventario before SAP operation
      const enrichedUploadableLines = parsedConsumoEnriched.lines.filter((line) => line.cantidadSalida > 0);
      const insertedRows = await postgresClient.upsertSalidaInventario(
        parsedConsumoEnriched.serieTicket,
        parsedConsumoEnriched.numeroTicket,
        storeConfig.empresa,
        storeConfig.tienda,
        parsedConsumo.storeName,
        parsedConsumo.firstBusinessDate,
        parsedConsumoEnriched.fechaHoraIngreso,
        enrichedUploadableLines
      );

      logger.info("CONSUMOS rows saved to pos.salida_inventario", {
        fileName: downloadedFile.fileName,
        storeNumber,
        businessDate,
        insertedRows
      });

      const externalId = buildConsumoExternalId(downloadedFile.fileName, storeNumber, parsedConsumo.firstBusinessDate);
      const payload = mapConsumoToSapInventoryExitPayload({
        externalId,
        businessDate: parsedConsumo.firstBusinessDate,
        fileName: downloadedFile.fileName,
        storeNumber,
        warehouseCode: storeConfig.warehouseCode,
        costingCode: storeConfig.costingCode,
        lines: uploadableLines
      });
      const payloadItemCodes = payload.DocumentLines.map((line) => line.ItemCode);
      const payloadWarehouses = Array.from(new Set(payload.DocumentLines.map((line) => line.WarehouseCode)));
      const payloadCostingCodes = Array.from(
        new Set(payload.DocumentLines.map((line) => line.CostingCode).filter((value): value is string => Boolean(value)))
      );

      logger.info("CONSUMOS SAP payload prepared", {
        fileName: downloadedFile.fileName,
        storeNumber,
        businessDate,
        externalId,
        docDate: payload.DocDate,
        lineCount: payload.DocumentLines.length,
        sampleItemCodes: payloadItemCodes.slice(0, 20),
        warehouses: payloadWarehouses,
        costingCodes: payloadCostingCodes
      });

      const payloadHash = hashPayload(payload);
      const delivery = await middlewareClient.getOrCreateConsumoDelivery(
        downloadedFile.fileName,
        downloadedFile.remotePath,
        payloadHash
      );
      deliveryAttempt = { id: delivery.id, attempts: delivery.attempts };

      if (delivery.payloadHash !== payloadHash) {
        const errorMessage = `Payload changed for existing CONSUMOS delivery ${downloadedFile.fileName}`;
        logger.info("CONSUMOS delivery blocked", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          reason: errorMessage
        });
        await middlewareClient.failConsumoDelivery(delivery.id, errorMessage, true);
        await middlewareClient.openAlert({
          severity: "error",
          category: "consumo_delivery_payload_changed",
          deduplicationKey: `consumo_delivery_payload_changed:${downloadedFile.fileName}`,
          message: errorMessage,
          context: { fileName: downloadedFile.fileName }
        });
        await middlewareClient.closeConsumoFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          responsePayload: payload,
          errorMessage
        });
        continue;
      }

      if (delivery.status === "manual_intervention_required") {
        logger.info("CONSUMOS delivery skipped", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          reason: "CONSUMOS delivery requires manual intervention"
        });
        await middlewareClient.closeConsumoFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          responsePayload: payload,
          errorMessage: "CONSUMOS delivery requires manual intervention"
        });
        continue;
      }

      if (delivery.status === "confirmed" && delivery.sapDocNum !== null && delivery.sapDocEntry !== null) {
        sapSuccess = true;
        sapDocNum = delivery.sapDocNum;
        sapDocEntry = delivery.sapDocEntry;
      } else {
        if (delivery.attempts >= MAX_CONSUMO_DELIVERY_ATTEMPTS) {
          const errorMessage = `CONSUMOS delivery exhausted ${MAX_CONSUMO_DELIVERY_ATTEMPTS} attempts`;
          logger.info("CONSUMOS delivery skipped", {
            fileName: downloadedFile.fileName,
            storeNumber,
            businessDate,
            attempts: delivery.attempts,
            reason: errorMessage
          });
          await middlewareClient.failConsumoDelivery(delivery.id, errorMessage, true);
          await middlewareClient.openAlert({
            severity: "error",
            category: "consumo_delivery_failed",
            deduplicationKey: `consumo_delivery_failed:${downloadedFile.fileName}`,
            message: errorMessage,
            context: { fileName: downloadedFile.fileName, attempts: delivery.attempts }
          });
          await middlewareClient.closeConsumoFileEvent(fileEventId, {
            status: "failed",
            sapSuccess,
            totalLines,
            uploadedLines,
            skippedLines,
            movedToOk,
            storeNumber,
            businessDate,
            responsePayload: payload,
            errorMessage
          });
          continue;
        }

        await middlewareClient.markConsumoDeliverySending(delivery.id);
        const existingDocument = await sapClient.findInventoryExitByExternalId(externalId);
        const posted = existingDocument ?? await sapClient.postInventoryExit(payload);
        await middlewareClient.confirmConsumoDelivery(delivery.id, posted.DocNum, posted.DocEntry);

        sapSuccess = true;
        sapDocNum = posted.DocNum;
        sapDocEntry = posted.DocEntry;

        // Update the persisted rows with the SAP document number
        await postgresClient.updateSalidaInventarioDocNum(
          parsedConsumoEnriched.serieTicket,
          parsedConsumoEnriched.numeroTicket,
          posted.DocNum
        );

        logger.info("CONSUMOS inventory exit synced to SAP", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          totalLines,
          uploadedLines,
          skippedLines,
          docNum: posted.DocNum,
          docEntry: posted.DocEntry,
          recoveredExistingDocument: Boolean(existingDocument)
        });
      }

      if (sapSuccess) {
        if (shouldMoveToOk) {
          await sftpService.moveConsumoFileToOk(downloadedFile.fileName);
          movedToOk = true;
        }
        processedFiles.push(downloadedFile.fileName);
      }

      await middlewareClient.closeConsumoFileEvent(fileEventId, {
        status: sapSuccess ? "uploaded" : "failed",
        sapSuccess,
        totalLines,
        uploadedLines,
        skippedLines,
        movedToOk,
        sapDocNum,
        sapDocEntry,
        storeNumber,
        businessDate,
        responsePayload: payload
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error("CONSUMOS file processing failed", {
        fileName: downloadedFile.fileName,
        remotePath: downloadedFile.remotePath,
        storeNumber,
        businessDate,
        totalLines,
        uploadedLines,
        skippedLines,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error
      });

      if (deliveryAttempt) {
        const requiresManualIntervention = deliveryAttempt.attempts + 1 >= MAX_CONSUMO_DELIVERY_ATTEMPTS;
        await middlewareClient.failConsumoDelivery(
          deliveryAttempt.id,
          errorMessage,
          requiresManualIntervention
        ).catch(() => {});

        if (requiresManualIntervention) {
          await middlewareClient.openAlert({
            severity: "error",
            category: "consumo_delivery_failed",
            deduplicationKey: `consumo_delivery_failed:${downloadedFile.fileName}`,
            message: `CONSUMOS delivery exhausted ${MAX_CONSUMO_DELIVERY_ATTEMPTS} attempts: ${errorMessage}`,
            context: { fileName: downloadedFile.fileName, attempts: deliveryAttempt.attempts + 1 }
          }).catch(() => {});
        }
      }

      await middlewareClient.closeConsumoFileEvent(fileEventId, {
        status: "failed",
        sapSuccess,
        totalLines,
        uploadedLines,
        skippedLines,
        movedToOk,
        sapDocNum,
        sapDocEntry,
        storeNumber,
        businessDate,
        errorMessage
      }).catch(() => {});
    } finally {
      try {
        await fs.rm(downloadedFile.localPath, { force: true });
        localFileDeleted = true;
      } catch (cleanupError) {
        logger.error("CONSUMOS local file cleanup failed", {
          fileName: downloadedFile.fileName,
          localPath: downloadedFile.localPath,
          error: cleanupError instanceof Error
            ? { message: cleanupError.message, stack: cleanupError.stack }
            : cleanupError
        });
      }

      if (localFileDeleted) {
        logger.info("Local CONSUMOS file deleted", {
          fileName: downloadedFile.fileName,
          filePath: downloadedFile.localPath
        });
      }
    }
  }

  return processedFiles;
};

const processEntradaFiles = async (
  sftpService: MicrosSftpService,
  postgresClient: PostgresClient,
  sapClient: SapServiceLayerClient,
  middlewareClient: MiddlewareDbClient,
  runId: number,
  range: ProcessingDateRange,
  options?: { downloadedFiles?: DownloadedMicrosExport[] }
): Promise<string[]> => {
  const processedFiles: string[] = [];
  const downloadedFiles = options?.downloadedFiles
    ?? await sftpService.downloadEntradaFiles({ startDate: range.startDate, endDate: range.endDate });
  logger.info("ENTRADAS files ready for operation", {
    count: downloadedFiles.length,
    source: options?.downloadedFiles ? "local" : "sftp"
  });

  for (const downloadedFile of downloadedFiles) {
    const fileEventId = await middlewareClient.openEntradaFileEvent(
      runId,
      downloadedFile.fileName,
      downloadedFile.remotePath
    );

    let movedToOk = false;
    let sapSuccess = false;
    let totalLines = 0;
    let uploadedLines = 0;
    let skippedLines = 0;
    let sapDocNum: number | undefined;
    let sapDocEntry: number | undefined;
    let storeNumber = "";
    let businessDate = "";
    let deliveryAttempt: { id: number; attempts: number } | null = null;
    let localFileDeleted = false;

    try {
      const content = await fs.readFile(downloadedFile.localPath, "utf-8");
      const entradaJson = JSON.parse(content) as ConsumoJsonExport;
      const parsedEntrada = parseMicrosInventoryEntries(entradaJson);
      storeNumber = parsedEntrada.storeNumber;
      businessDate = parsedEntrada.firstBusinessDate;

      logger.info("ENTRADAS file parsed", {
        fileName: downloadedFile.fileName,
        storeNumber,
        businessDate,
        rawLineCount: parsedEntrada.lines.length
      });

      const storeConfig = await postgresClient.getStoreSapInventoryConfigBySimphonyStoreNumber(storeNumber);
      if (!storeConfig || !storeConfig.enableUploadingDocuments) {
        const errorMessage = `Store ${storeNumber} is not enabled for SAP inventory upload`;
        logger.info("ENTRADAS file skipped before SAP upload", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          reason: errorMessage
        });
        await middlewareClient.openAlert({
          severity: "warning",
          category: "entrada_store_mapping_missing",
          deduplicationKey: `entrada_store_mapping_missing:${storeNumber}`,
          message: errorMessage,
          context: { storeNumber, fileName: downloadedFile.fileName }
        });
        await middlewareClient.closeEntradaFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          errorMessage
        });
        continue;
      }

      if (!storeConfig.warehouseCode) {
        const errorMessage = `Store ${storeNumber} is missing codigo_almacen_sap in tienda`;
        logger.info("ENTRADAS file skipped before SAP upload", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          reason: errorMessage
        });
        await middlewareClient.openAlert({
          severity: "error",
          category: "entrada_store_mapping_missing",
          deduplicationKey: `entrada_store_mapping_missing:${storeNumber}`,
          message: errorMessage,
          context: { storeNumber, fileName: downloadedFile.fileName }
        });
        await middlewareClient.closeEntradaFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          errorMessage
        });
        continue;
      }

      const groupedLines = new Map<string, { skuProducto: string; descripcionProducto: string; unidadMedida: string; cantidad: number; precioUnitario: number }>();
      for (const line of parsedEntrada.lines) {
        const existing = groupedLines.get(line.skuProducto);
        if (existing) {
          existing.cantidad += line.cantidad;
          existing.precioUnitario += line.precioUnitario;
        } else {
          groupedLines.set(line.skuProducto, { ...line });
        }
      }

      totalLines = parsedEntrada.lines.length;
      const uploadableLines = Array.from(groupedLines.values()).filter((line) => line.cantidad > 0);

      uploadedLines = uploadableLines.length;
      skippedLines = Math.max(totalLines - uploadedLines, 0);

      logger.info("ENTRADAS line aggregation summary", {
        fileName: downloadedFile.fileName,
        storeNumber,
        businessDate,
        totalLines,
        uploadedLines,
        skippedLines
      });

      if (uploadableLines.length === 0) {
        const errorMessage = `ENTRADAS file ${downloadedFile.fileName} has no valid lines to upload`;
        logger.info("ENTRADAS file skipped before SAP upload", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          totalLines,
          uploadedLines,
          skippedLines,
          reason: errorMessage
        });
        await middlewareClient.closeEntradaFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          errorMessage
        });
        continue;
      }

      // Persist parsed lines to pos.entrada_mercancia before SAP operation
      const insertedRows = await postgresClient.upsertEntradaMercancia(
        parsedEntrada.serieTicket,
        parsedEntrada.numeroTicket,
        storeConfig.empresa,
        storeConfig.tienda,
        parsedEntrada.firstBusinessDate,
        uploadableLines
      );

      logger.info("ENTRADAS rows saved to pos.entrada_mercancia", {
        fileName: downloadedFile.fileName,
        storeNumber,
        businessDate,
        insertedRows
      });

      const externalId = buildEntradaExternalId(downloadedFile.fileName, storeNumber, parsedEntrada.firstBusinessDate);
      const payload = mapEntradaToSapInventoryEntryPayload({
        externalId,
        businessDate: parsedEntrada.firstBusinessDate,
        fileName: downloadedFile.fileName,
        storeNumber,
        warehouseCode: storeConfig.warehouseCode,
        lines: uploadableLines.map((line) => ({ itemCode: line.skuProducto, quantity: line.cantidad }))
      });

      logger.info("ENTRADAS SAP payload prepared", {
        fileName: downloadedFile.fileName,
        storeNumber,
        businessDate,
        externalId,
        docDate: payload.DocDate,
        lineCount: payload.DocumentLines.length,
        sampleItemCodes: payload.DocumentLines.map((line) => line.ItemCode).slice(0, 20)
      });

      const payloadHash = hashPayload(payload);
      const delivery = await middlewareClient.getOrCreateEntradaDelivery(
        downloadedFile.fileName,
        downloadedFile.remotePath,
        payloadHash
      );
      deliveryAttempt = { id: delivery.id, attempts: delivery.attempts };

      if (delivery.payloadHash !== payloadHash) {
        const errorMessage = `Payload changed for existing ENTRADAS delivery ${downloadedFile.fileName}`;
        logger.info("ENTRADAS delivery blocked", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          reason: errorMessage
        });
        await middlewareClient.failEntradaDelivery(delivery.id, errorMessage, true);
        await middlewareClient.openAlert({
          severity: "error",
          category: "entrada_delivery_payload_changed",
          deduplicationKey: `entrada_delivery_payload_changed:${downloadedFile.fileName}`,
          message: errorMessage,
          context: { fileName: downloadedFile.fileName }
        });
        await middlewareClient.closeEntradaFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          responsePayload: payload,
          errorMessage
        });
        continue;
      }

      if (delivery.status === "manual_intervention_required") {
        logger.info("ENTRADAS delivery skipped", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          reason: "ENTRADAS delivery requires manual intervention"
        });
        await middlewareClient.closeEntradaFileEvent(fileEventId, {
          status: "failed",
          sapSuccess,
          totalLines,
          uploadedLines,
          skippedLines,
          movedToOk,
          storeNumber,
          businessDate,
          responsePayload: payload,
          errorMessage: "ENTRADAS delivery requires manual intervention"
        });
        continue;
      }

      if (delivery.status === "confirmed" && delivery.sapDocNum !== null && delivery.sapDocEntry !== null) {
        sapSuccess = true;
        sapDocNum = delivery.sapDocNum;
        sapDocEntry = delivery.sapDocEntry;
      } else {
        if (delivery.attempts >= MAX_ENTRADA_DELIVERY_ATTEMPTS) {
          const errorMessage = `ENTRADAS delivery exhausted ${MAX_ENTRADA_DELIVERY_ATTEMPTS} attempts`;
          logger.info("ENTRADAS delivery skipped", {
            fileName: downloadedFile.fileName,
            storeNumber,
            businessDate,
            attempts: delivery.attempts,
            reason: errorMessage
          });
          await middlewareClient.failEntradaDelivery(delivery.id, errorMessage, true);
          await middlewareClient.openAlert({
            severity: "error",
            category: "entrada_delivery_failed",
            deduplicationKey: `entrada_delivery_failed:${downloadedFile.fileName}`,
            message: errorMessage,
            context: { fileName: downloadedFile.fileName, attempts: delivery.attempts }
          });
          await middlewareClient.closeEntradaFileEvent(fileEventId, {
            status: "failed",
            sapSuccess,
            totalLines,
            uploadedLines,
            skippedLines,
            movedToOk,
            storeNumber,
            businessDate,
            responsePayload: payload,
            errorMessage
          });
          continue;
        }

        await middlewareClient.markEntradaDeliverySending(delivery.id);
        const existingDocument = await sapClient.findInventoryEntryByExternalId(externalId);
        const posted = existingDocument ?? await sapClient.postInventoryEntry(payload);
        await middlewareClient.confirmEntradaDelivery(delivery.id, posted.DocNum, posted.DocEntry);

        sapSuccess = true;
        sapDocNum = posted.DocNum;
        sapDocEntry = posted.DocEntry;

        // Update the persisted rows with the SAP document number
        await postgresClient.updateEntradaMercanciaDocNum(
          parsedEntrada.serieTicket,
          parsedEntrada.numeroTicket,
          posted.DocNum
        );

        logger.info("ENTRADAS inventory entry synced to SAP", {
          fileName: downloadedFile.fileName,
          storeNumber,
          businessDate,
          totalLines,
          uploadedLines,
          skippedLines,
          docNum: posted.DocNum,
          docEntry: posted.DocEntry,
          recoveredExistingDocument: Boolean(existingDocument)
        });
      }

      if (sapSuccess) {
        processedFiles.push(downloadedFile.fileName);
      }

      await middlewareClient.closeEntradaFileEvent(fileEventId, {
        status: sapSuccess ? "uploaded" : "failed",
        sapSuccess,
        totalLines,
        uploadedLines,
        skippedLines,
        movedToOk,
        sapDocNum,
        sapDocEntry,
        storeNumber,
        businessDate,
        responsePayload: payload
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error("ENTRADAS file processing failed", {
        fileName: downloadedFile.fileName,
        remotePath: downloadedFile.remotePath,
        storeNumber,
        businessDate,
        totalLines,
        uploadedLines,
        skippedLines,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error
      });

      if (deliveryAttempt) {
        const requiresManualIntervention = deliveryAttempt.attempts + 1 >= MAX_ENTRADA_DELIVERY_ATTEMPTS;
        await middlewareClient.failEntradaDelivery(
          deliveryAttempt.id,
          errorMessage,
          requiresManualIntervention
        ).catch(() => {});

        if (requiresManualIntervention) {
          await middlewareClient.openAlert({
            severity: "error",
            category: "entrada_delivery_failed",
            deduplicationKey: `entrada_delivery_failed:${downloadedFile.fileName}`,
            message: `ENTRADAS delivery exhausted ${MAX_ENTRADA_DELIVERY_ATTEMPTS} attempts: ${errorMessage}`,
            context: { fileName: downloadedFile.fileName, attempts: deliveryAttempt.attempts + 1 }
          }).catch(() => {});
        }
      }

      await middlewareClient.closeEntradaFileEvent(fileEventId, {
        status: "failed",
        sapSuccess,
        totalLines,
        uploadedLines,
        skippedLines,
        movedToOk,
        sapDocNum,
        sapDocEntry,
        storeNumber,
        businessDate,
        errorMessage
      }).catch(() => {});
    } finally {
      try {
        await fs.rm(downloadedFile.localPath, { force: true });
        localFileDeleted = true;
      } catch (cleanupError) {
        logger.error("ENTRADAS local file cleanup failed", {
          fileName: downloadedFile.fileName,
          localPath: downloadedFile.localPath,
          error: cleanupError instanceof Error
            ? { message: cleanupError.message, stack: cleanupError.stack }
            : cleanupError
        });
      }

      if (localFileDeleted) {
        logger.info("Local ENTRADAS file deleted", {
          fileName: downloadedFile.fileName,
          filePath: downloadedFile.localPath
        });
      }
    }
  }

  return processedFiles;
};

const processInventoryFlowsInFullIntegration = async (
  sftpService: MicrosSftpService,
  postgresClient: PostgresClient,
  sapClient: SapServiceLayerClient,
  middlewareClient: MiddlewareDbClient,
  runId: number,
  range: ProcessingDateRange
): Promise<void> => {
  const entradaFiles = await processEntradaFiles(
    sftpService,
    postgresClient,
    sapClient,
    middlewareClient,
    runId,
    range
  );
  const consumoFiles = await processConsumoFiles(
    sftpService,
    postgresClient,
    sapClient,
    middlewareClient,
    runId,
    range,
    { moveToOk: false }
  );

  for (const fileName of consumoFiles) {
    await sftpService.moveConsumoFileToOk(fileName);
  }
};

export const processPendingInvoicesInSapOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const postgresClient = new PostgresClient(appConfig.postgres);
  const sapClient = new SapServiceLayerClient(appConfig.sap);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("SAP sync skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "sap_sync",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-sap-sync");
  await postgresClient.connect();

  try {
    await syncPendingSalesToSap(postgresClient, sapClient, middlewareClient, runId, range);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await postgresClient.disconnect();
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
  const postgresClient = new PostgresClient(appConfig.postgres);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("MICROS ingest skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "sftp_ingest",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-sync");
  await postgresClient.connect();

  try {
    await ingestMicrosExports(sftpService, postgresClient, middlewareClient, runId, range);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    await postgresClient.disconnect();
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
  const postgresClient = new PostgresClient(appConfig.postgres);
  const sapClient = new SapServiceLayerClient(appConfig.sap);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("Full integration skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "full_integration",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-full-sync");
  await postgresClient.connect();

  try {
    await ingestMicrosExports(sftpService, postgresClient, middlewareClient, runId, range);
    if (appConfig.fullSyncEnableSapUpload) {
      await processInventoryFlowsInFullIntegration(sftpService, postgresClient, sapClient, middlewareClient, runId, range);
      await syncPendingSalesToSap(postgresClient, sapClient, middlewareClient, runId, range);
    } else {
      logger.info("Full integration skipped SAP document upload because FULL_SYNC_ENABLE_SAP_UPLOAD is disabled", {
        runId,
        startDate: range.startDate,
        endDate: range.endDate
      });
    }
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await postgresClient.disconnect();
      await middlewareClient.disconnect().catch(() => {});
    }
  }
};

export const processPedidosFilesOnce = async (
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const pedidoApiClient = new PedidoApiClient(appConfig.pedidosApi);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(PEDIDOS_JOB_LOCK_NAME))) {
    logger.info("PEDIDOS upload skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "pedido_upload",
    triggerMode
  });

  startLoggerInactivityWatchdog(180000, "manual-pedido-sync");

  try {
    await processPedidoFiles(sftpService, pedidoApiClient, middlewareClient, runId);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    await middlewareClient.disconnect().catch(() => {});
  }
};

export const processConsumosFilesOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sapClient = new SapServiceLayerClient(appConfig.sap);
  const postgresClient = new PostgresClient(appConfig.postgres);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("CONSUMOS upload skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "consumo_upload",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-consumo-sync");
  await postgresClient.connect();

  try {
    await processConsumoFiles(sftpService, postgresClient, sapClient, middlewareClient, runId, range);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await postgresClient.disconnect();
      await middlewareClient.disconnect().catch(() => {});
    }
  }
};

export const processEntradasFilesOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sapClient = new SapServiceLayerClient(appConfig.sap);
  const postgresClient = new PostgresClient(appConfig.postgres);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("ENTRADAS upload skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "entrada_upload",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-entrada-sync");
  await postgresClient.connect();

  try {
    await processEntradaFiles(sftpService, postgresClient, sapClient, middlewareClient, runId, range);
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await postgresClient.disconnect();
      await middlewareClient.disconnect().catch(() => {});
    }
  }
};

export const downloadPedidosFilesOnce = async (
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(PEDIDOS_JOB_LOCK_NAME))) {
    logger.info("PEDIDOS download skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "pedido_upload",
    triggerMode
  });

  startLoggerInactivityWatchdog(180000, "manual-pedido-download");

  try {
    const downloadedFiles = await sftpService.downloadPedidoFiles();
    logger.info("PEDIDOS files downloaded for later operation", { count: downloadedFiles.length });
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    await middlewareClient.disconnect().catch(() => {});
  }
};

export const uploadPedidosFilesOnce = async (
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const pedidoApiClient = new PedidoApiClient(appConfig.pedidosApi);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);
  const pedidoFlowPaths = resolvePedidosFlowPaths();

  if (!(await middlewareClient.tryAcquireJobLock(PEDIDOS_JOB_LOCK_NAME))) {
    logger.info("PEDIDOS upload skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "pedido_upload",
    triggerMode
  });

  startLoggerInactivityWatchdog(180000, "manual-pedido-upload");

  try {
    const localFiles = await listLocalDownloadedPedidoFiles({
      localDir: pedidoFlowPaths.localDir,
      remoteDir: pedidoFlowPaths.remoteDir
    });
    await processPedidoFiles(sftpService, pedidoApiClient, middlewareClient, runId, { downloadedFiles: localFiles });
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    await middlewareClient.disconnect().catch(() => {});
  }
};

export const downloadConsumosFilesOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("CONSUMOS download skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "consumo_upload",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-consumo-download");

  try {
    const downloadedFiles = await sftpService.downloadConsumoFiles({ startDate: range.startDate, endDate: range.endDate });
    logger.info("CONSUMOS files downloaded for later SAP operation", { count: downloadedFiles.length });
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    await middlewareClient.disconnect().catch(() => {});
  }
};

export const uploadConsumosFilesToSapOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sapClient = new SapServiceLayerClient(appConfig.sap);
  const postgresClient = new PostgresClient(appConfig.postgres);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);
  const consumoFlowPaths = resolveConsumosFlowPaths();

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("CONSUMOS upload skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "consumo_upload",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-consumo-upload");
  await postgresClient.connect();

  try {
    const localFiles = await listLocalDownloadedFiles({
      localDir: consumoFlowPaths.localDir,
      remoteDir: consumoFlowPaths.remoteDir,
      range,
      parseFileDate: parseInventoryMovementFileDate,
      flowName: "CONSUMOS"
    });
    await processConsumoFiles(sftpService, postgresClient, sapClient, middlewareClient, runId, range, {
      downloadedFiles: localFiles
    });
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await postgresClient.disconnect();
      await middlewareClient.disconnect().catch(() => {});
    }
  }
};

export const downloadEntradasFilesOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("ENTRADAS download skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "entrada_upload",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-entrada-download");

  try {
    const downloadedFiles = await sftpService.downloadEntradaFiles({ startDate: range.startDate, endDate: range.endDate });
    logger.info("ENTRADAS files downloaded for later SAP operation", { count: downloadedFiles.length });
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    await middlewareClient.disconnect().catch(() => {});
  }
};

export const uploadEntradasFilesToSapOnce = async (
  startDateInput?: string | Date,
  endDateInput?: string | Date,
  triggerMode: "cron" | "manual" = "manual"
): Promise<void> => {
  const range = resolveProcessingDateRange(startDateInput, endDateInput);
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sapClient = new SapServiceLayerClient(appConfig.sap);
  const postgresClient = new PostgresClient(appConfig.postgres);
  const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);
  const entradaFlowPaths = resolveEntradasFlowPaths();

  if (!(await middlewareClient.tryAcquireJobLock(DEFAULT_JOB_LOCK_NAME))) {
    logger.info("ENTRADAS upload skipped because another execution is already running");
    await middlewareClient.disconnect();
    return;
  }

  const runId = await middlewareClient.createRun({
    jobType: "entrada_upload",
    triggerMode,
    dateRangeStart: range.startDate,
    dateRangeEnd: range.endDate
  });

  startLoggerInactivityWatchdog(180000, "manual-entrada-upload");
  await postgresClient.connect();

  try {
    const localFiles = await listLocalDownloadedFiles({
      localDir: entradaFlowPaths.localDir,
      remoteDir: entradaFlowPaths.remoteDir,
      range,
      parseFileDate: parseInventoryMovementFileDate,
      flowName: "ENTRADAS"
    });
    await processEntradaFiles(sftpService, postgresClient, sapClient, middlewareClient, runId, range, {
      downloadedFiles: localFiles
    });
    await middlewareClient.finishRun(runId, "success");
  } catch (error) {
    await middlewareClient.finishRun(runId, "failed", error instanceof Error ? error.message : String(error)).catch(() => {});
    throw error;
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await postgresClient.disconnect();
      await middlewareClient.disconnect().catch(() => {});
    }
  }
};

const runScheduledJob = async (schedule: Pick<JobSchedule, "jobType" | "name">): Promise<void> => {
  try {
    switch (schedule.jobType) {
      case "sftp_ingest":
        await processMicrosFilesOnce(undefined, undefined, "cron");
        break;
      case "sap_sync":
        await processPendingInvoicesInSapOnce(undefined, undefined, "cron");
        break;
      case "full_integration":
        await runFullIntegrationOnce(undefined, undefined, "cron");
        break;
      case "pedido_upload":
        await processPedidosFilesOnce("cron");
        break;
      case "consumo_upload":
        await processConsumosFilesOnce(undefined, undefined, "cron");
        break;
      case "entrada_upload":
        await processEntradasFilesOnce(undefined, undefined, "cron");
        break;
    }
  } catch (error) {
    logger.error("Scheduled integration job failed", {
      scheduleName: schedule.name,
      jobType: schedule.jobType,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error
    });
  }
};

export const startNightlySyncJob = (): void => {
  const scheduledTasks = new Map<string, { signature: string; task: ReturnType<typeof cron.schedule> }>();

  const reconcileSchedules = async (): Promise<void> => {
    const middlewareClient = new MiddlewareDbClient(appConfig.middlewareDb);
    try {
      const databaseSchedules = await middlewareClient.getEnabledJobSchedules();
      const baseSchedules: JobSchedule[] = databaseSchedules.length > 0
        ? databaseSchedules.filter((schedule) => schedule.jobType !== "pedido_upload")
        : [
            {
              id: 0,
              name: "fallback-sap-sync",
              jobType: "sap_sync",
              cronExpression: appConfig.cronExpression,
              timezone: appConfig.cronTimezone
            }
          ];

      const schedules: JobSchedule[] = [
        ...baseSchedules,
        {
          id: -1,
          name: "fallback-pedido-upload",
          jobType: "pedido_upload",
          cronExpression: "*/5 * * * *",
          timezone: appConfig.cronTimezone
        }
      ];
      const activeNames = new Set(schedules.map((schedule) => schedule.name));

      for (const [name, scheduled] of scheduledTasks) {
        if (!activeNames.has(name)) {
          scheduled.task.stop();
          scheduledTasks.delete(name);
        }
      }

      for (const schedule of schedules) {
        const signature = `${schedule.jobType}|${schedule.cronExpression}|${schedule.timezone}`;
        const existing = scheduledTasks.get(schedule.name);
        if (existing?.signature === signature) continue;

        existing?.task.stop();
        const task = cron.schedule(
          schedule.cronExpression,
          () => void runScheduledJob(schedule),
          { timezone: schedule.timezone }
        );
        scheduledTasks.set(schedule.name, { signature, task });
        logger.info("Integration schedule registered", {
          name: schedule.name,
          jobType: schedule.jobType,
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone
        });
      }
    } catch (error) {
      logger.error("Integration schedule refresh failed", {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error
      });
    } finally {
      await middlewareClient.disconnect().catch(() => {});
    }
  };

  void reconcileSchedules();
  setInterval(() => void reconcileSchedules(), 60_000);
};
