import { startNightlySyncJob } from "./jobs/nightlySyncJob.js";
import { logger } from "./services/logger.js";

startNightlySyncJob();
logger.info("Nightly integration jobs scheduled.");
