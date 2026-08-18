import path from "node:path";
import dotenv from "dotenv";
import type { MiddlewareDbConfig } from "../services/db/middlewareClient.js";
import type { PedidoApiConfig } from "../services/pedidos/pedidoApiClient.js";
import type { SapServiceLayerConfig } from "../services/sap/sapServiceLayerClient.js";
import type { PostgresConfig } from "../services/db/postgresClient.js";
import type { SftpConfig } from "../services/sftp/sftpClient.js";

dotenv.config();

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const appConfig = {
  cronExpression: process.env.CRON_EXPRESSION ?? "0 23 * * *",
  cronTimezone: process.env.CRON_TIMEZONE ?? "America/Mexico_City",
  fullSyncEnableSapUpload: process.env.FULL_SYNC_ENABLE_SAP_UPLOAD === "true",
  strictSapItemMapping: process.env.SAP_STRICT_ITEM_MAPPING === "true",
  sapInvoiceSeries: Number(process.env.SAP_INVOICE_SERIES ?? "144"),
  sftp: {
    host: required("SFTP_HOST"),
    port: Number(process.env.SFTP_PORT ?? "22"),
    username: required("SFTP_USERNAME"),
    password: required("SFTP_PASSWORD"),
    remoteDir: required("SFTP_REMOTE_DIR"),
    localDir: process.env.SFTP_LOCAL_DIR ?? path.resolve(process.cwd(), "data", "micros"),
    pedidosRemoteDir: process.env.SFTP_PEDIDOS_REMOTE_DIR,
    pedidosLocalDir: process.env.SFTP_PEDIDOS_LOCAL_DIR ?? path.resolve(process.cwd(), "data", "pedidos"),
    consumosRemoteDir: process.env.SFTP_CONSUMOS_REMOTE_DIR,
    consumosLocalDir: process.env.SFTP_CONSUMOS_LOCAL_DIR ?? path.resolve(process.cwd(), "data", "consumos"),
    entradasRemoteDir: process.env.SFTP_ENTRADAS_REMOTE_DIR,
    entradasLocalDir: process.env.SFTP_ENTRADAS_LOCAL_DIR ?? path.resolve(process.cwd(), "data", "entradas")
  } satisfies SftpConfig,
  pedidosApi: {
    uploadUrl: required("PEDIDOS_API_UPLOAD_URL"),
    timeoutMs: Number(process.env.PEDIDOS_API_TIMEOUT_MS ?? "20000"),
    allowSelfSignedCert: process.env.PEDIDOS_API_ALLOW_SELF_SIGNED_CERT === "true",
    debugRequests: process.env.ETL_DEBUG_PEDIDOS_API === "true"
  } satisfies PedidoApiConfig,
  postgres: {
    host: required("POSTGRES_HOST"),
    port: Number(process.env.POSTGRES_PORT ?? "5432"),
    database: required("POSTGRES_DATABASE"),
    user: required("POSTGRES_USER"),
    password: required("POSTGRES_PASSWORD"),
    sslEnabled: process.env.POSTGRES_SSL_ENABLED === "true",
    sslRejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== "false"
  } satisfies PostgresConfig,
  sap: {
    baseUrl: required("SAP_BASE_URL"),
    companyDB: required("SAP_COMPANY_DB"),
    username: required("SAP_USERNAME"),
    password: required("SAP_PASSWORD"),
    externalIdField: process.env.SAP_EXTERNAL_ID_FIELD?.trim() || undefined,
    allowSelfSignedCert: process.env.SAP_ALLOW_SELF_SIGNED_CERT === "true",
    debugRequests: process.env.ETL_DEBUG_SAP === "true"
  } satisfies SapServiceLayerConfig,
  middlewareDb: {
    host: required("MIDDLEWARE_DB_HOST"),
    port: Number(process.env.MIDDLEWARE_DB_PORT ?? "5432"),
    database: process.env.MIDDLEWARE_DB_NAME ?? "micros_middleware_dev",
    user: required("MIDDLEWARE_DB_USER"),
    password: required("MIDDLEWARE_DB_PASSWORD"),
    sslEnabled: process.env.MIDDLEWARE_DB_SSL_ENABLED !== "false",
    sslRejectUnauthorized: process.env.MIDDLEWARE_DB_SSL_REJECT_UNAUTHORIZED !== "false"
  } satisfies MiddlewareDbConfig
};
