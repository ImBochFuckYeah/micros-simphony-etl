import fs from "node:fs/promises";
import cron from "node-cron";
import { appConfig } from "../config/env.js";
import { SqlServerClient, type PendingSale } from "../services/db/sqlServerClient.js";
import { logger } from "../services/logger.js";
import { parseMicrosSales } from "../services/micros/microsParser.js";
import { SapServiceLayerClient, type SapSalePayload } from "../services/sap/sapServiceLayerClient.js";
import { MicrosSftpService } from "../services/sftp/sftpClient.js";
import type { MicrosJsonExport } from "../types/micros.js";

const mapSaleToSapPayload = (sale: PendingSale): SapSalePayload => ({
  U_MICROS_ExternalId: sale.externalId,
  DocDate: sale.businessDate,
  DocTotal: sale.totalAmount,
  DocumentLines: sale.details.map((detail) => ({
    ItemCode: detail.itemCode,
    Quantity: detail.quantity,
    LineTotal: detail.lineAmount
  }))
});

const ingestMicrosExports = async (
  sftpService: MicrosSftpService,
  sqlServerClient: SqlServerClient
): Promise<void> => {
  const downloadedFiles = await sftpService.downloadNewMicrosExports();
  logger.info("SFTP export files downloaded", { count: downloadedFiles.length });

  for (const filePath of downloadedFiles) {
    const content = await fs.readFile(filePath, "utf-8");
    const microsJson = JSON.parse(content) as MicrosJsonExport;
    const { headers, details } = parseMicrosSales(microsJson);
    logger.info("SFTP file parsed", {
      filePath,
      headers: headers.length,
      details: details.length
    });

    if (headers.length > 0) {
      const insertStats = await sqlServerClient.insertSales(headers, details);
      logger.info("SQL upsert summary for file", {
        filePath,
        ...insertStats
      });
    }
  }
};

const syncPendingSalesToSap = async (
  sqlServerClient: SqlServerClient,
  sapClient: SapServiceLayerClient
): Promise<void> => {
  const pendingSales = await sqlServerClient.getPendingSales();
  logger.info("Pending sales loaded for SAP sync", { count: pendingSales.length });

  for (const sale of pendingSales) {
    const payload = mapSaleToSapPayload(sale);
    await sapClient.postSale(payload);
    await sqlServerClient.markSalesAsSynced([sale.idFactura]);
    logger.info("Sale synced to SAP", {
      idFactura: sale.idFactura,
      externalId: sale.externalId
    });
  }
};

export const processPendingInvoicesInSapOnce = async (): Promise<void> => {
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);
  const sapClient = new SapServiceLayerClient(appConfig.sap);

  await sqlServerClient.connect();

  try {
    await syncPendingSalesToSap(sqlServerClient, sapClient);
  } finally {
    try {
      await sapClient.logout();
    } finally {
      await sqlServerClient.disconnect();
    }
  }
};

export const runIntegrationOnce = async (): Promise<void> => {
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);
  const sapClient = new SapServiceLayerClient(appConfig.sap);

  await sqlServerClient.connect();

  try {
    await ingestMicrosExports(sftpService, sqlServerClient);
    // await syncPendingSalesToSap(sqlServerClient, sapClient);
  } finally {
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
