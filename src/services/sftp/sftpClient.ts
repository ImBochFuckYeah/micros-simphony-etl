import fs from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import { logger } from "../logger.js";

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
  localDir: string;
  pedidosRemoteDir?: string;
  pedidosLocalDir?: string;
  consumosRemoteDir?: string;
  consumosLocalDir?: string;
}

export interface DownloadedMicrosExport {
  localPath: string;
  remotePath: string;
  fileName: string;
}

export interface MicrosExportDateRange {
  startDate: string;
  endDate: string;
}

const parsePedidoFileDate = (fileName: string): Date | null => {
  const match = /^PED(\d{4})(\d{2})(\d{2})\d+\.txt$/i.exec(fileName);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsedDate = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getFullYear() !== year ||
    parsedDate.getMonth() !== month - 1 ||
    parsedDate.getDate() !== day
  ) {
    return null;
  }

  return parsedDate;
};

const parseMicrosFileDate = (fileName: string): Date | null => {
  if (!fileName.startsWith("RA_")) {
    return null;
  }

  const match = /_(\d{2})(\d{2})(\d{2})_N\.json$/i.exec(fileName);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = 2000 + Number(match[3]);
  const parsedDate = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getFullYear() !== year ||
    parsedDate.getMonth() !== month - 1 ||
    parsedDate.getDate() !== day
  ) {
    return null;
  }

  return parsedDate;
};

const parseConsumoFileDate = (fileName: string): Date | null => {
  const match = /^CONSUMO_[^_]+_(\d{2})(\d{2})(\d{2})_N\.json$/i.exec(fileName);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = 2000 + Number(match[3]);
  const parsedDate = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getFullYear() !== year ||
    parsedDate.getMonth() !== month - 1 ||
    parsedDate.getDate() !== day
  ) {
    return null;
  }

  return parsedDate;
};

const normalizeDateOnly = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const isDateWithinRange = (date: Date, range: MicrosExportDateRange): boolean => {
  const parsedStart = new Date(`${range.startDate}T00:00:00`);
  const parsedEnd = new Date(`${range.endDate}T00:00:00`);

  if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) {
    return false;
  }

  const candidate = normalizeDateOnly(date);
  return candidate >= normalizeDateOnly(parsedStart) && candidate <= normalizeDateOnly(parsedEnd);
};

export class MicrosSftpService {
  private readonly client = new SftpClient();

  constructor(private readonly config: SftpConfig) {}

  private get pedidosRemoteDir(): string {
    return this.config.pedidosRemoteDir ?? path.posix.join(this.config.remoteDir, "PEDIDOS");
  }

  private get pedidosLocalDir(): string {
    return this.config.pedidosLocalDir ?? path.join(this.config.localDir, "PEDIDOS");
  }

  private get consumosRemoteDir(): string {
    return this.config.consumosRemoteDir ?? path.posix.join(this.config.remoteDir, "CONSUMOS");
  }

  private get consumosLocalDir(): string {
    return this.config.consumosLocalDir ?? path.join(this.config.localDir, "CONSUMOS");
  }

  private async connect(): Promise<void> {
    await this.client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password
    });
  }

  async downloadNewMicrosExports(range: MicrosExportDateRange): Promise<DownloadedMicrosExport[]> {
    await fs.mkdir(this.config.localDir, { recursive: true });

    await this.connect();

    try {
      const remoteFiles = await this.client.list(this.config.remoteDir);
      logger.info("SFTP remote directory listed", {
        remoteDir: this.config.remoteDir,
        count: remoteFiles.length,
        sampleFiles: remoteFiles.slice(0, 25).map((file) => ({ name: file.name, type: file.type }))
      });

      const jsonFiles = remoteFiles.filter((file) => file.type === "-" && file.name.endsWith(".json"));
      logger.info("SFTP JSON files matched by filter", {
        remoteDir: this.config.remoteDir,
        count: jsonFiles.length,
        sampleFiles: jsonFiles.slice(0, 25).map((file) => file.name)
      });

      const filesInRange = jsonFiles.filter((file) => {
        const fileDate = parseMicrosFileDate(file.name);
        return fileDate ? isDateWithinRange(fileDate, range) : false;
      });

      logger.info("SFTP JSON files matched by date range", {
        remoteDir: this.config.remoteDir,
        startDate: range.startDate,
        endDate: range.endDate,
        count: filesInRange.length,
        sampleFiles: filesInRange.slice(0, 25).map((file) => file.name)
      });

      const downloaded: DownloadedMicrosExport[] = [];

      for (const [index, file] of filesInRange.entries()) {
        const localPath = path.join(this.config.localDir, file.name);
        const remotePath = path.posix.join(this.config.remoteDir, file.name);

        logger.info("SFTP download started", {
          index: index + 1,
          total: filesInRange.length,
          fileName: file.name
        });

        await this.client.fastGet(remotePath, localPath);

        logger.info("SFTP download finished", {
          index: index + 1,
          total: filesInRange.length,
          fileName: file.name,
          localPath
        });

        downloaded.push({
          localPath,
          remotePath,
          fileName: file.name
        });
      }

      return downloaded;
    } finally {
      await this.client.end();
    }
  }

  async downloadPedidoFiles(range: MicrosExportDateRange): Promise<DownloadedMicrosExport[]> {
    await fs.mkdir(this.pedidosLocalDir, { recursive: true });
    await this.connect();

    try {
      const remoteFiles = await this.client.list(this.pedidosRemoteDir);
      const files = remoteFiles.filter((file) => {
        if (file.type !== "-") {
          return false;
        }

        const fileDate = parsePedidoFileDate(file.name);
        if (!fileDate) {
          return false;
        }

        const parsedStart = new Date(`${range.startDate}T00:00:00`);
        const parsedEnd = new Date(`${range.endDate}T00:00:00`);
        if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) {
          return false;
        }

        const candidate = new Date(fileDate.getFullYear(), fileDate.getMonth(), fileDate.getDate());
        return (
          candidate >= new Date(parsedStart.getFullYear(), parsedStart.getMonth(), parsedStart.getDate()) &&
          candidate <= new Date(parsedEnd.getFullYear(), parsedEnd.getMonth(), parsedEnd.getDate())
        );
      });

      logger.info("SFTP PEDIDOS files matched", {
        remoteDir: this.pedidosRemoteDir,
        startDate: range.startDate,
        endDate: range.endDate,
        count: files.length,
        sampleFiles: files.slice(0, 25).map((file) => file.name)
      });

      const downloaded: DownloadedMicrosExport[] = [];

      for (const [index, file] of files.entries()) {
        const localPath = path.join(this.pedidosLocalDir, file.name);
        const remotePath = path.posix.join(this.pedidosRemoteDir, file.name);

        logger.info("SFTP PEDIDOS download started", {
          index: index + 1,
          total: files.length,
          fileName: file.name
        });

        await this.client.fastGet(remotePath, localPath);

        logger.info("SFTP PEDIDOS download finished", {
          index: index + 1,
          total: files.length,
          fileName: file.name,
          localPath
        });

        downloaded.push({
          localPath,
          remotePath,
          fileName: file.name
        });
      }

      return downloaded;
    } finally {
      await this.client.end();
    }
  }

  async moveMicrosExportToOk(fileName: string): Promise<void> {
    const sourcePath = path.posix.join(this.config.remoteDir, fileName);
    const targetPath = path.posix.join(this.config.remoteDir, "OK", fileName);

    await this.connect();

    try {
      await this.client.rename(sourcePath, targetPath);
    } finally {
      await this.client.end();
    }
  }

  async movePedidoFileToOk(fileName: string): Promise<void> {
    const sourcePath = path.posix.join(this.pedidosRemoteDir, fileName);
    const okDir = path.posix.join(this.pedidosRemoteDir, "OK");
    const targetPath = path.posix.join(okDir, fileName);

    await this.connect();

    try {
      const okDirExists = await this.client.exists(okDir);
      if (!okDirExists) {
        await this.client.mkdir(okDir, true);
      }

      await this.client.rename(sourcePath, targetPath);
    } finally {
      await this.client.end();
    }
  }

  async downloadConsumoFiles(range: MicrosExportDateRange): Promise<DownloadedMicrosExport[]> {
    await fs.mkdir(this.consumosLocalDir, { recursive: true });
    await this.connect();

    try {
      const remoteFiles = await this.client.list(this.consumosRemoteDir);
      const files = remoteFiles.filter((file) => {
        if (file.type !== "-") {
          return false;
        }

        const fileDate = parseConsumoFileDate(file.name);
        return fileDate ? isDateWithinRange(fileDate, range) : false;
      });

      logger.info("SFTP CONSUMOS files matched", {
        remoteDir: this.consumosRemoteDir,
        startDate: range.startDate,
        endDate: range.endDate,
        count: files.length,
        sampleFiles: files.slice(0, 25).map((file) => file.name)
      });

      const downloaded: DownloadedMicrosExport[] = [];

      for (const [index, file] of files.entries()) {
        const localPath = path.join(this.consumosLocalDir, file.name);
        const remotePath = path.posix.join(this.consumosRemoteDir, file.name);

        logger.info("SFTP CONSUMOS download started", {
          index: index + 1,
          total: files.length,
          fileName: file.name
        });

        await this.client.fastGet(remotePath, localPath);

        logger.info("SFTP CONSUMOS download finished", {
          index: index + 1,
          total: files.length,
          fileName: file.name,
          localPath
        });

        downloaded.push({
          localPath,
          remotePath,
          fileName: file.name
        });
      }

      return downloaded;
    } finally {
      await this.client.end();
    }
  }

  async moveConsumoFileToOk(fileName: string): Promise<void> {
    const sourcePath = path.posix.join(this.consumosRemoteDir, fileName);
    const okDir = path.posix.join(this.consumosRemoteDir, "OK");
    const targetPath = path.posix.join(okDir, fileName);

    await this.connect();

    try {
      const okDirExists = await this.client.exists(okDir);
      if (!okDirExists) {
        await this.client.mkdir(okDir, true);
      }

      await this.client.rename(sourcePath, targetPath);
    } finally {
      await this.client.end();
    }
  }
}
