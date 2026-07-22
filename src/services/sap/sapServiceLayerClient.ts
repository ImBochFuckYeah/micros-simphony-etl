import axios, { AxiosError, type AxiosInstance } from "axios";
import https from "node:https";
import { logger } from "../logger.js";

interface SapSessionResponse {
  SessionId: string;
}

export interface SapSalePayload {
  U_MICROS_ExternalId: string;
  DocDate: string;
  DocTotal: number;
  DocumentLines: Array<{
    ItemCode: string;
    Quantity: number;
    LineTotal: number;
  }>;
}

export interface SapServiceLayerConfig {
  baseUrl: string;
  companyDB: string;
  username: string;
  password: string;
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

  async postSale(payload: SapSalePayload): Promise<void> {
    await this.ensureAuthenticated();

    this.debug("SAP invoice request", {
      url: "/Invoices",
      externalId: payload.U_MICROS_ExternalId,
      docDate: payload.DocDate,
      docTotal: payload.DocTotal,
      lineCount: payload.DocumentLines.length
    });

    try {
      const response = await this.http.post("/Invoices", payload, {
        headers: { Cookie: this.sessionCookie }
      });

      this.debug("SAP invoice response", {
        status: response.status,
        externalId: payload.U_MICROS_ExternalId
      });
    } catch (error) {
      if (this.isUnauthorized(error)) {
        this.debug("SAP invoice unauthorized, retrying login", {
          externalId: payload.U_MICROS_ExternalId
        });
        await this.login();
        const retryResponse = await this.http.post("/Invoices", payload, {
          headers: { Cookie: this.sessionCookie }
        });

        this.debug("SAP invoice retry response", {
          status: retryResponse.status,
          externalId: payload.U_MICROS_ExternalId
        });
        return;
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

  private debug(message: string, context?: Record<string, unknown>): void {
    if (!this.config.debugRequests) return;
    logger.info(message, context);
  }
}
