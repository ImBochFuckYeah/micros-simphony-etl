import fs from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
  localDir: string;
}

export class MicrosSftpService {
  private readonly client = new SftpClient();

  constructor(private readonly config: SftpConfig) {}

  async downloadNewMicrosExports(): Promise<string[]> {
    await fs.mkdir(this.config.localDir, { recursive: true });

    await this.client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password
    });

    try {
      const remoteFiles = await this.client.list(this.config.remoteDir);
      const jsonFiles = remoteFiles.filter((file) => file.type === "-" && file.name.endsWith(".json"));
      const downloaded: string[] = [];

      for (const file of jsonFiles) {
        const localPath = path.join(this.config.localDir, file.name);
        await this.client.fastGet(path.posix.join(this.config.remoteDir, file.name), localPath);
        downloaded.push(localPath);
      }

      return downloaded;
    } finally {
      await this.client.end();
    }
  }
}
