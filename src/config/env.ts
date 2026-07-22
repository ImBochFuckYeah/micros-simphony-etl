import path from "node:path";
import dotenv from "dotenv";
import type { SapServiceLayerConfig } from "../services/sap/sapServiceLayerClient.js";
import type { SqlServerConfig } from "../services/db/sqlServerClient.js";
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
  sftp: {
    host: required("SFTP_HOST"),
    port: Number(process.env.SFTP_PORT ?? "22"),
    username: required("SFTP_USERNAME"),
    password: required("SFTP_PASSWORD"),
    remoteDir: required("SFTP_REMOTE_DIR"),
    localDir: process.env.SFTP_LOCAL_DIR ?? path.resolve(process.cwd(), "data", "micros")
  } satisfies SftpConfig,
  sqlServer: {
    user: required("SQL_USER"),
    password: required("SQL_PASSWORD"),
    server: required("SQL_SERVER"),
    database: required("SQL_DATABASE"),
    options: {
      encrypt: process.env.SQL_ENCRYPT === "true",
      trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE !== "false"
    }
  } satisfies SqlServerConfig,
  sap: {
    baseUrl: required("SAP_BASE_URL"),
    companyDB: required("SAP_COMPANY_DB"),
    username: required("SAP_USERNAME"),
    password: required("SAP_PASSWORD"),
    allowSelfSignedCert: process.env.SAP_ALLOW_SELF_SIGNED_CERT === "true",
    debugRequests: process.env.ETL_DEBUG_SAP === "true"
  } satisfies SapServiceLayerConfig
};
