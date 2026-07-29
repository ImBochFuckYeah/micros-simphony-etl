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
}

export interface DownloadedMicrosExport {
  localPath: string;
  remotePath: string;
  fileName: string;
}

export class MicrosSftpService {
  private readonly client = new SftpClient();

  constructor(private readonly config: SftpConfig) {}

  async downloadNewMicrosExports(): Promise<DownloadedMicrosExport[]> {
    await fs.mkdir(this.config.localDir, { recursive: true });

    await this.client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password
    });

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

      const downloaded: DownloadedMicrosExport[] = [];

      for (const [index, file] of jsonFiles.entries()) {
        const localPath = path.join(this.config.localDir, file.name);
        const remotePath = path.posix.join(this.config.remoteDir, file.name);

        logger.info("SFTP download started", {
          index: index + 1,
          total: jsonFiles.length,
          fileName: file.name
        });

        await this.client.fastGet(remotePath, localPath);

        logger.info("SFTP download finished", {
          index: index + 1,
          total: jsonFiles.length,
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

    await this.client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password
    });

    try {
      await this.client.rename(sourcePath, targetPath);
    } finally {
      await this.client.end();
    }
  }
}
