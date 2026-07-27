import { describe, it, expect, vi, afterEach } from "vitest";
import jsforce from "jsforce";
import { buildConnection } from "./connection.js";
import type { SalesforceCredentials } from "../utils/config.js";

const CLIENT_CREDS: SalesforceCredentials = {
  authFlow: "client_credentials",
  clientId: "client-id-a",
  clientSecret: "client-secret-a",
  instanceUrl: "https://my-org.my.salesforce.com",
};

const USER_PASS_CREDS: SalesforceCredentials = {
  authFlow: "username_password",
  username: "user@example.com",
  password: "hunter2",
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildConnection — client credentials flow", () => {
  it("throws when clientId, clientSecret, or instanceUrl is missing", async () => {
    await expect(
      buildConnection({ authFlow: "client_credentials", clientSecret: "s", instanceUrl: "https://x" }),
    ).rejects.toThrow(/requires clientId, clientSecret, and instanceUrl/);
    await expect(
      buildConnection({ authFlow: "client_credentials", clientId: "c", instanceUrl: "https://x" }),
    ).rejects.toThrow(/requires clientId, clientSecret, and instanceUrl/);
    await expect(
      buildConnection({ authFlow: "client_credentials", clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow(/requires clientId, clientSecret, and instanceUrl/);
  });

  it("posts to <instanceUrl>/services/oauth2/token with a trailing slash stripped", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { access_token: "tok-a", instance_url: "https://my-org.my.salesforce.com" }));

    await buildConnection({ ...CLIENT_CREDS, instanceUrl: "https://my-org.my.salesforce.com/" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://my-org.my.salesforce.com/services/oauth2/token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    const sentBody = new URLSearchParams(init?.body as string);
    expect(sentBody.get("grant_type")).toBe("client_credentials");
    expect(sentBody.get("client_id")).toBe("client-id-a");
    expect(sentBody.get("client_secret")).toBe("client-secret-a");
  });

  it("throws with the response body when the token endpoint returns a non-ok status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad_request: invalid client",
      json: async () => ({}),
    } as Response);

    await expect(buildConnection(CLIENT_CREDS)).rejects.toThrow(
      /Salesforce OAuth token endpoint returned 400: bad_request: invalid client/,
    );
  });

  it("throws a Salesforce-specific error when the payload carries an error field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { error: "invalid_client_id", error_description: "client identifier invalid" }),
    );

    await expect(buildConnection(CLIENT_CREDS)).rejects.toThrow(
      /Salesforce OAuth error: invalid_client_id — client identifier invalid/,
    );
  });

  it("falls back to a generic description when error_description is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { error: "invalid_client_id" }));

    await expect(buildConnection(CLIENT_CREDS)).rejects.toThrow(/no description/);
  });

  it("throws when the response is ok but access_token is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { instance_url: "https://my-org.my.salesforce.com" }));

    await expect(buildConnection(CLIENT_CREDS)).rejects.toThrow(/missing access_token/);
  });

  it("resolves instanceUrl from the token response (My Domain redirect)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { access_token: "tok-a", instance_url: "https://my-domain-redirect.my.salesforce.com" }),
    );

    const result = await buildConnection(CLIENT_CREDS);

    expect(result.resolvedInstanceUrl).toBe("https://my-domain-redirect.my.salesforce.com");
    expect(result.authFlow).toBe("client_credentials");
    expect(result.connection).toBeInstanceOf(jsforce.Connection);
  });

  it("falls back to the requested instanceUrl when the token response omits instance_url", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { access_token: "tok-a" }));

    const result = await buildConnection(CLIENT_CREDS);

    expect(result.resolvedInstanceUrl).toBe(CLIENT_CREDS.instanceUrl);
  });
});

describe("buildConnection — username/password flow", () => {
  it("throws when username or password is missing", async () => {
    await expect(buildConnection({ authFlow: "username_password", password: "p" })).rejects.toThrow(
      /requires username and password/,
    );
    await expect(buildConnection({ authFlow: "username_password", username: "u" })).rejects.toThrow(
      /requires username and password/,
    );
  });

  it("appends the security token to the password when present", async () => {
    const loginSpy = vi
      .spyOn(jsforce.Connection.prototype, "login")
      .mockImplementation(async function (this: { instanceUrl?: string }) {
        this.instanceUrl = "https://resolved-org.my.salesforce.com";
        return {} as never;
      });

    await buildConnection({ ...USER_PASS_CREDS, securityToken: "SECTOK" });

    expect(loginSpy).toHaveBeenCalledWith("user@example.com", "hunter2SECTOK");
  });

  it("uses the bare password when no security token is present", async () => {
    const loginSpy = vi
      .spyOn(jsforce.Connection.prototype, "login")
      .mockImplementation(async function (this: { instanceUrl?: string }) {
        this.instanceUrl = "https://resolved-org.my.salesforce.com";
        return {} as never;
      });

    await buildConnection(USER_PASS_CREDS);

    expect(loginSpy).toHaveBeenCalledWith("user@example.com", "hunter2");
  });

  it("defaults the login URL to https://login.salesforce.com when instanceUrl is not set", async () => {
    let capturedLoginUrl: string | undefined;
    const ConnectionSpy = vi.spyOn(jsforce, "Connection").mockImplementation(function (
      this: unknown,
      opts?: { loginUrl?: string },
    ) {
      capturedLoginUrl = opts?.loginUrl;
      return Object.assign(this as object, {
        login: async () => ({}),
        instanceUrl: "https://resolved-org.my.salesforce.com",
      });
    } as unknown as typeof jsforce.Connection);

    await buildConnection(USER_PASS_CREDS);

    expect(capturedLoginUrl).toBe("https://login.salesforce.com");
    ConnectionSpy.mockRestore();
  });

  it("uses the provided instanceUrl as the login URL when set (e.g. a sandbox)", async () => {
    let capturedLoginUrl: string | undefined;
    const ConnectionSpy = vi.spyOn(jsforce, "Connection").mockImplementation(function (
      this: unknown,
      opts?: { loginUrl?: string },
    ) {
      capturedLoginUrl = opts?.loginUrl;
      return Object.assign(this as object, {
        login: async () => ({}),
        instanceUrl: "https://resolved-org.my.salesforce.com",
      });
    } as unknown as typeof jsforce.Connection);

    await buildConnection({ ...USER_PASS_CREDS, instanceUrl: "https://test.salesforce.com" });

    expect(capturedLoginUrl).toBe("https://test.salesforce.com");
    ConnectionSpy.mockRestore();
  });

  it("resolves instanceUrl from connection.instanceUrl after login (may differ from loginUrl)", async () => {
    vi.spyOn(jsforce.Connection.prototype, "login").mockImplementation(async function (this: {
      instanceUrl?: string;
    }) {
      this.instanceUrl = "https://actual-org-instance.my.salesforce.com";
      return {} as never;
    });

    const result = await buildConnection(USER_PASS_CREDS);

    expect(result.resolvedInstanceUrl).toBe("https://actual-org-instance.my.salesforce.com");
    expect(result.authFlow).toBe("username_password");
  });

  it("resolves to jsforce's empty-string default (not loginUrl) when login() leaves instanceUrl untouched", async () => {
    // jsforce.Connection's defaultConnectionConfig.instanceUrl is '' — never
    // undefined — so `connection.instanceUrl ?? loginUrl` in connection.ts
    // (which only catches null/undefined) can't actually fall back to
    // loginUrl here. In real usage this never matters: a successful SOAP
    // login always populates a non-empty instanceUrl from the response.
    vi.spyOn(jsforce.Connection.prototype, "login").mockImplementation(async function () {
      return {} as never;
    });

    const result = await buildConnection(USER_PASS_CREDS);

    expect(result.resolvedInstanceUrl).toBe("");
  });
});
