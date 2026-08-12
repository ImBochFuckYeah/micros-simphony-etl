import axios, { AxiosError, type AxiosInstance } from "axios";
import https from "node:https";
import { logger } from "../logger.js";

interface SapSessionResponse {
  SessionId: string;
}

export interface SapSalePayload {
  CardCode: string;
  Series?: number;
  U_MICROS_ExternalId?: string;
  DocDate: string;
  DocDueDate?: string;
  ReserveInvoice?: "tYES" | "tNO";
  Comments?: string;
  DocumentLines: Array<{
    ItemCode: string;
    Quantity: number;
    PriceAfterVAT: number;
    WarehouseCode: string;
  }>;
}

export interface SapInventoryExitPayload {
  U_MICROS_ExternalId?: string;
  DocDate: string;
  Comments?: string;
  DocumentLines: Array<{
    ItemCode: string;
    Quantity: number;
    WarehouseCode: string;
    CostingCode?: string;
  }>;
}

export interface SapInventoryEntryPayload {
  U_MICROS_ExternalId?: string;
  DocDate: string;
  Comments?: string;
  DocumentLines: Array<{
    ItemCode: string;
    Quantity: number;
    WarehouseCode: string;
    Price?: number;
    AccountCode?: string;
  }>;
}

export interface SapPostedDocument {
  DocEntry: number;
  DocNum: number;
}

interface SapItemsResponse {
  value: Array<{
    ItemCode: string;
    U_ID_SIMPHONY: string | null;
  }>;
  "@odata.nextLink"?: string;
}

interface SapDocumentLookupResponse {
  value: Array<{
    DocEntry: number;
    DocNum: number;
  }>;
}

export interface SapServiceLayerConfig {
  baseUrl: string;
  companyDB: string;
  username: string;
  password: string;
  externalIdField?: string;
  allowSelfSignedCert?: boolean;
  debugRequests?: boolean;
}

const toSapErrorContext = (error: AxiosError): Record<string, unknown> => ({
  status: error.response?.status,
  method: error.config?.method,
  url: error.config?.url,
  data: error.response?.data
});

export class SapServiceLayerClient {
  private readonly http: AxiosInstance;
  private sessionCookie = "";

  constructor(private readonly config: SapServiceLayerConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: 20000,
      httpsAgent: new https.Agent({
        rejectUnauthorized: !config.allowSelfSignedCert
      }),
      headers: { "Content-Type": "application/json" }
    });
  }

  async login(): Promise<void> {
    this.debug("SAP login request", {
      url: "/Login",
      companyDB: this.config.companyDB,
      username: this.config.username
    });

    const response = await this.http.post<SapSessionResponse>("/Login", {
      CompanyDB: this.config.companyDB,
      UserName: this.config.username,
      Password: this.config.password
    });

    this.debug("SAP login response", {
      status: response.status,
      hasSetCookie: Array.isArray(response.headers["set-cookie"])
    });

    const setCookie = response.headers["set-cookie"];
    if (!Array.isArray(setCookie) || setCookie.length === 0) {
      throw new Error("SAP login did not return a valid session cookie");
    }

    const relevantCookies = setCookie
      .map((cookie) => cookie.split(";")[0])
      .filter((cookie) => cookie.startsWith("B1SESSION=") || cookie.startsWith("ROUTEID="));

    if (relevantCookies.length === 0 || !response.data.SessionId) {
      throw new Error("SAP login failed: B1SESSION was not returned");
    }

    this.sessionCookie = relevantCookies.join("; ");
  }

  async postSale(payload: SapSalePayload): Promise<SapPostedDocument> {
    await this.ensureAuthenticated();
    const requestPayload = this.withConfiguredExternalIdField(payload);

    this.debug("SAP invoice request", {
      url: "/Invoices",
      externalId: payload.U_MICROS_ExternalId,
      docDate: payload.DocDate,
      lineCount: payload.DocumentLines.length
    });

    try {
      const response = await this.http.post("/Invoices", requestPayload, {
        headers: { Cookie: this.sessionCookie }
      });

      this.debug("SAP invoice response", {
        status: response.status,
        externalId: payload.U_MICROS_ExternalId
      });

      return this.extractPostedDocument(response.data);
    } catch (error) {
      if (this.isUnauthorized(error)) {
        this.debug("SAP invoice unauthorized, retrying login", {
          externalId: payload.U_MICROS_ExternalId
        });
        await this.login();
        const retryResponse = await this.http.post("/Invoices", requestPayload, {
          headers: { Cookie: this.sessionCookie }
        });

        this.debug("SAP invoice retry response", {
          status: retryResponse.status,
          externalId: payload.U_MICROS_ExternalId
        });
        return this.extractPostedDocument(retryResponse.data);
      }

      if (error instanceof AxiosError) {
        this.debug("SAP invoice error", {
          externalId: payload.U_MICROS_ExternalId,
          ...toSapErrorContext(error)
        });
        throw new Error(
          `SAP rejected transaction (${error.response?.status ?? "NO_STATUS"}): ${JSON.stringify(error.response?.data)}`
        );
      }

      throw error;
    }
  }

  async findSaleByExternalId(externalId: string): Promise<SapPostedDocument | null> {
    await this.ensureAuthenticated();

    const externalIdField = this.config.externalIdField?.trim();
    if (!externalIdField) {
      this.debug("SAP invoice lookup skipped because no external ID field is configured", {
        externalId
      });
      return null;
    }

    const escapedExternalId = externalId.replace(/'/g, "''");
    const response = await this.http.get<SapDocumentLookupResponse>(
      `/Invoices?$select=DocEntry,DocNum&$filter=${externalIdField} eq '${escapedExternalId}'&$top=1`,
      { headers: { Cookie: this.sessionCookie } }
    );
    const document = response.data.value[0];

    return document ? this.extractPostedDocument(document) : null;
  }

  async postInventoryExit(payload: SapInventoryExitPayload): Promise<SapPostedDocument> {
    await this.ensureAuthenticated();
    const requestPayload = this.withConfiguredExternalIdField(payload);

    this.debug("SAP inventory exit request", {
      url: "/InventoryGenExits",
      externalId: payload.U_MICROS_ExternalId,
      docDate: payload.DocDate,
      lineCount: payload.DocumentLines.length,
      payload: requestPayload
    });

    try {
      const response = await this.http.post("/InventoryGenExits", requestPayload, {
        headers: { Cookie: this.sessionCookie }
      });

      this.debug("SAP inventory exit response", {
        status: response.status,
        externalId: payload.U_MICROS_ExternalId
      });

      return this.extractPostedDocument(response.data);
    } catch (error) {
      if (this.isUnauthorized(error)) {
        this.debug("SAP inventory exit unauthorized, retrying login", {
          externalId: payload.U_MICROS_ExternalId
        });
        await this.login();
        const retryResponse = await this.http.post("/InventoryGenExits", requestPayload, {
          headers: { Cookie: this.sessionCookie }
        });

        this.debug("SAP inventory exit retry response", {
          status: retryResponse.status,
          externalId: payload.U_MICROS_ExternalId
        });
        return this.extractPostedDocument(retryResponse.data);
      }

      if (error instanceof AxiosError) {
        this.debug("SAP inventory exit error", {
          externalId: payload.U_MICROS_ExternalId,
          payload: requestPayload,
          ...toSapErrorContext(error)
        });
        throw new Error(
          `SAP rejected inventory exit (${error.response?.status ?? "NO_STATUS"}): ${JSON.stringify(error.response?.data)}`
        );
      }

      throw error;
    }
  }

  async findInventoryExitByExternalId(externalId: string): Promise<SapPostedDocument | null> {
    await this.ensureAuthenticated();

    const externalIdField = this.config.externalIdField?.trim();
    if (!externalIdField) {
      this.debug("SAP inventory exit lookup skipped because no external ID field is configured", {
        externalId
      });
      return null;
    }

    const escapedExternalId = externalId.replace(/'/g, "''");
    const response = await this.http.get<SapDocumentLookupResponse>(
      `/InventoryGenExits?$select=DocEntry,DocNum&$filter=${externalIdField} eq '${escapedExternalId}'&$top=1`,
      { headers: { Cookie: this.sessionCookie } }
    );
    const document = response.data.value[0];

    return document ? this.extractPostedDocument(document) : null;
  }

  async postInventoryEntry(payload: SapInventoryEntryPayload): Promise<SapPostedDocument> {
    await this.ensureAuthenticated();
    const requestPayload = this.withConfiguredExternalIdField(payload);

    this.debug("SAP inventory entry request", {
      url: "/InventoryGenEntries",
      externalId: payload.U_MICROS_ExternalId,
      docDate: payload.DocDate,
      lineCount: payload.DocumentLines.length,
      payload: requestPayload
    });

    try {
      const response = await this.http.post("/InventoryGenEntries", requestPayload, {
        headers: { Cookie: this.sessionCookie }
      });

      this.debug("SAP inventory entry response", {
        status: response.status,
        externalId: payload.U_MICROS_ExternalId
      });

      return this.extractPostedDocument(response.data);
    } catch (error) {
      if (this.isUnauthorized(error)) {
        this.debug("SAP inventory entry unauthorized, retrying login", {
          externalId: payload.U_MICROS_ExternalId
        });
        await this.login();
        const retryResponse = await this.http.post("/InventoryGenEntries", requestPayload, {
          headers: { Cookie: this.sessionCookie }
        });

        this.debug("SAP inventory entry retry response", {
          status: retryResponse.status,
          externalId: payload.U_MICROS_ExternalId
        });
        return this.extractPostedDocument(retryResponse.data);
      }

      if (error instanceof AxiosError) {
        this.debug("SAP inventory entry error", {
          externalId: payload.U_MICROS_ExternalId,
          payload: requestPayload,
          ...toSapErrorContext(error)
        });
        throw new Error(
          `SAP rejected inventory entry (${error.response?.status ?? "NO_STATUS"}): ${JSON.stringify(error.response?.data)}`
        );
      }

      throw error;
    }
  }

  async findInventoryEntryByExternalId(externalId: string): Promise<SapPostedDocument | null> {
    await this.ensureAuthenticated();

    const externalIdField = this.config.externalIdField?.trim();
    if (!externalIdField) {
      this.debug("SAP inventory entry lookup skipped because no external ID field is configured", {
        externalId
      });
      return null;
    }

    const escapedExternalId = externalId.replace(/'/g, "''");
    const response = await this.http.get<SapDocumentLookupResponse>(
      `/InventoryGenEntries?$select=DocEntry,DocNum&$filter=${externalIdField} eq '${escapedExternalId}'&$top=1`,
      { headers: { Cookie: this.sessionCookie } }
    );
    const document = response.data.value[0];

    return document ? this.extractPostedDocument(document) : null;
  }

  async getSalesItemsBySimphonyId(): Promise<Map<string, string>> {
    await this.ensureAuthenticated();

    const itemsBySimphonyId = new Map<string, string>();
    const basePath = "/Items?$select=ItemCode,ItemName,U_ID_SIMPHONY&$filter=U_ID_SIMPHONY ne null";
    let nextPath = basePath;
    let fallbackSkip = 0;
    const defaultPageSize = 20;

    while (true) {
      const response = await this.http.get<SapItemsResponse>(nextPath, {
        headers: { Cookie: this.sessionCookie }
      });

      const pageItems = response.data.value ?? [];
      for (const item of pageItems) {
        const simphonyId = item.U_ID_SIMPHONY?.trim();
        if (!simphonyId) continue;
        if (!itemsBySimphonyId.has(simphonyId)) {
          itemsBySimphonyId.set(simphonyId, item.ItemCode);
        }
      }

      const nextLink = response.data["@odata.nextLink"];
      if (nextLink) {
        nextPath = `/${nextLink.replace(/^\/+/, "")}`;
        continue;
      }

      if (pageItems.length < defaultPageSize) {
        break;
      }

      fallbackSkip += defaultPageSize;
      nextPath = `${basePath}&$skip=${fallbackSkip}`;
    }

    return itemsBySimphonyId;
  }

  async logout(): Promise<void> {
    if (!this.sessionCookie) return;

    this.debug("SAP logout request", { url: "/Logout" });

    try {
      const response = await this.http.post(
        "/Logout",
        {},
        {
          headers: { Cookie: this.sessionCookie }
        }
      );

      this.debug("SAP logout response", { status: response.status });
    } finally {
      this.sessionCookie = "";
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.sessionCookie) {
      await this.login();
    }
  }

  private isUnauthorized(error: unknown): error is AxiosError {
    return error instanceof AxiosError && error.response?.status === 401;
  }

  private withConfiguredExternalIdField<T extends { U_MICROS_ExternalId?: string }>(payload: T): Omit<T, "U_MICROS_ExternalId"> & Record<string, unknown> {
    const { U_MICROS_ExternalId, ...basePayload } = payload;
    const externalIdField = this.config.externalIdField?.trim();

    if (!externalIdField || !U_MICROS_ExternalId) {
      return basePayload;
    }

    return {
      ...basePayload,
      [externalIdField]: U_MICROS_ExternalId
    };
  }

  private extractPostedDocument(data: unknown): SapPostedDocument {
    const payload = data as { DocEntry?: unknown; DocNum?: unknown };
    const docEntry = typeof payload.DocEntry === "number" ? payload.DocEntry : Number(payload.DocEntry);
    const docNum = typeof payload.DocNum === "number" ? payload.DocNum : Number(payload.DocNum);

    if (!Number.isFinite(docEntry) || !Number.isFinite(docNum)) {
      throw new Error(`SAP invoice response did not include DocEntry/DocNum: ${JSON.stringify(data)}`);
    }

    return {
      DocEntry: docEntry,
      DocNum: docNum
    };
  }

  private debug(message: string, context?: Record<string, unknown>): void {
    if (!this.config.debugRequests) return;
    logger.info(message, context);
  }
}
