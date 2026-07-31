import fs from "node:fs/promises";
import { logger } from "../logger.js";

export interface PedidoApiConfig {
  uploadUrl: string;
  timeoutMs: number;
  debugRequests?: boolean;
}

export interface PedidoUploadDetalle {
  success: boolean;
  numero_pedido?: string;
  error?: string;
}

export interface PedidoUploadResultadoArchivo {
  archivo: string;
  success: boolean;
  pedidos?: PedidoUploadDetalle[];
  error?: string;
}

export interface PedidoUploadResponse {
  success: boolean;
  total_archivos?: number;
  resultados?: PedidoUploadResultadoArchivo[];
}

export class PedidoApiClient {
  constructor(private readonly config: PedidoApiConfig) {}

  async uploadFile(localPath: string, fileName: string): Promise<PedidoUploadResponse> {
    const content = await fs.readFile(localPath);
    const form = new FormData();
    form.append("archivo", new Blob([content]), fileName);

    this.debug("Pedido API upload request", {
      uploadUrl: this.config.uploadUrl,
      fileName,
      sizeBytes: content.byteLength
    });

    const response = await fetch(this.config.uploadUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(
        `Pedido API upload failed (${response.status}): ${rawBody.slice(0, 1000)}`
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error(`Pedido API returned non-JSON response: ${rawBody.slice(0, 1000)}`);
    }

    this.debug("Pedido API upload response", {
      fileName,
      success: (payload as { success?: unknown }).success === true
    });

    return payload as PedidoUploadResponse;
  }

  private debug(message: string, context?: Record<string, unknown>): void {
    if (!this.config.debugRequests) return;
    logger.info(message, context);
  }
}
