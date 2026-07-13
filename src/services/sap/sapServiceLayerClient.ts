import axios, { AxiosError, type AxiosInstance } from "axios";

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
}

export class SapServiceLayerClient {
  private readonly http: AxiosInstance;
  private sessionCookie = "";

  constructor(private readonly config: SapServiceLayerConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: 20000,
      headers: { "Content-Type": "application/json" }
    });
  }

  async login(): Promise<void> {
    const response = await this.http.post<SapSessionResponse>("/Login", {
      CompanyDB: this.config.companyDB,
      UserName: this.config.username,
      Password: this.config.password
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

    try {
      await this.http.post("/Invoices", payload, {
        headers: { Cookie: this.sessionCookie }
      });
    } catch (error) {
      if (this.isUnauthorized(error)) {
        await this.login();
        await this.http.post("/Invoices", payload, {
          headers: { Cookie: this.sessionCookie }
        });
        return;
      }

      if (error instanceof AxiosError) {
        throw new Error(
          `SAP rejected transaction (${error.response?.status ?? "NO_STATUS"}): ${JSON.stringify(error.response?.data)}`
        );
      }

      throw error;
    }
  }

  async logout(): Promise<void> {
    if (!this.sessionCookie) return;

    try {
      await this.http.post(
        "/Logout",
        {},
        {
          headers: { Cookie: this.sessionCookie }
        }
      );
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
}
