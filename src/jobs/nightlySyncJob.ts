import fs from "node:fs/promises";
import cron from "node-cron";
import { appConfig } from "../config/env.js";
import { SqlServerClient } from "../services/db/sqlServerClient.js";
import { logger, startLoggerInactivityWatchdog, stopLoggerInactivityWatchdog } from "../services/logger.js";
import { parseMicrosSales } from "../services/micros/microsParser.js";
import { SapServiceLayerClient, type SapSalePayload } from "../services/sap/sapServiceLayerClient.js";
import { MicrosSftpService } from "../services/sftp/sftpClient.js";
import type { MicrosJsonExport } from "../types/micros.js";

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

const ingestMicrosExports = async (
  sftpService: MicrosSftpService,
  sqlServerClient: SqlServerClient
): Promise<void> => {
  const downloadedFiles = await sftpService.downloadNewMicrosExports();
  logger.info("SFTP export files downloaded", { count: downloadedFiles.length });

  for (const downloadedFile of downloadedFiles) {
    const content = await fs.readFile(downloadedFile.localPath, "utf-8");
    const microsJson = JSON.parse(content) as MicrosJsonExport;
    const { headers, details } = parseMicrosSales(microsJson);
    logger.info("SFTP file parsed", {
      filePath: downloadedFile.localPath,
      headers: headers.length,
      details: details.length
    });

    if (headers.length > 0) {
      const insertStats = await sqlServerClient.insertSales(headers, details);
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
    logger.info("SFTP file moved to OK", {
      fileName: downloadedFile.fileName,
      remotePath: downloadedFile.remotePath
    });

    await fs.rm(downloadedFile.localPath, { force: true });
    logger.info("Local downloaded file deleted", {
      filePath: downloadedFile.localPath
    });
  }
};

const syncPendingSalesToSap = async (
  sqlServerClient: SqlServerClient,
  sapClient: SapServiceLayerClient
): Promise<void> => {
  const pendingDocuments = await sqlServerClient.getPendingSapDocumentsForToday();
  logger.info("Pending consolidated sales loaded for SAP sync", { count: pendingDocuments.length });

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
  }
};

export const processPendingInvoicesInSapOnce = async (): Promise<void> => {
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);
  const sapClient = new SapServiceLayerClient(appConfig.sap);

  startLoggerInactivityWatchdog(180000, "manual-sap-sync");
  await sqlServerClient.connect();

  try {
    await syncPendingSalesToSap(sqlServerClient, sapClient);
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await sqlServerClient.disconnect();
    }
  }
};

export const processMicrosFilesOnce = async (): Promise<void> => {
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);

  startLoggerInactivityWatchdog(180000, "manual-sync");
  await sqlServerClient.connect();

  try {
    await ingestMicrosExports(sftpService, sqlServerClient);
  } finally {
    stopLoggerInactivityWatchdog();
    await sqlServerClient.disconnect();
  }
};

export const runFullIntegrationOnce = async (): Promise<void> => {
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);
  const sapClient = new SapServiceLayerClient(appConfig.sap);

  startLoggerInactivityWatchdog(180000, "manual-full-sync");
  await sqlServerClient.connect();

  try {
    await ingestMicrosExports(sftpService, sqlServerClient);
    await syncPendingSalesToSap(sqlServerClient, sapClient);
  } finally {
    stopLoggerInactivityWatchdog();
    try {
      await sapClient.logout();
    } finally {
      await sqlServerClient.disconnect();
    }
  }
};

export const startNightlySyncJob = (): void => {
  cron.schedule(
    appConfig.cronExpression,
    async () => {
      try {
        await processPendingInvoicesInSapOnce();
      } catch (error) {
        logger.error("Nightly SAP invoice processing failed", {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error
        });
      }
    },
    {
      timezone: appConfig.cronTimezone
    }
  );
};
