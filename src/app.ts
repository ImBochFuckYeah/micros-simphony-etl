import { startNightlySyncJob } from "./jobs/nightlySyncJob.js";
import { logger } from "./services/logger.js";

startNightlySyncJob();
logger.info("MICROS-SAP ETL job scheduled.");
