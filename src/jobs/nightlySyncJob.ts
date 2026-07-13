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

export const runIntegrationOnce = async (): Promise<void> => {
  const sftpService = new MicrosSftpService(appConfig.sftp);
  const sqlServerClient = new SqlServerClient(appConfig.sqlServer);
  const sapClient = new SapServiceLayerClient(appConfig.sap);

  await sqlServerClient.connect();

  try {
    const downloadedFiles = await sftpService.downloadNewMicrosExports();

    for (const filePath of downloadedFiles) {
      const content = await fs.readFile(filePath, "utf-8");
      const microsJson = JSON.parse(content) as MicrosJsonExport;
      const { headers, details } = parseMicrosSales(microsJson);

      if (headers.length > 0) {
        await sqlServerClient.insertSales(headers, details);
      }
    }

    const pendingSales = await sqlServerClient.getPendingSales();
    const syncedIds: number[] = [];

    for (const sale of pendingSales) {
      const payload = mapSaleToSapPayload(sale);
      await sapClient.postSale(payload);
      syncedIds.push(sale.idFacturaSemanal);
    }

    await sqlServerClient.markSalesAsSynced(syncedIds);
    await sapClient.logout();
  } finally {
    await sqlServerClient.disconnect();
  }
};

export const startNightlySyncJob = (): void => {
  cron.schedule(
    appConfig.cronExpression,
    async () => {
      try {
        await runIntegrationOnce();
      } catch (error) {
        logger.error("Nightly integration failed", {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error
        });
      }
    },
    {
      timezone: appConfig.cronTimezone
    }
  );
};
