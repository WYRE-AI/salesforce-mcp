import { describe, it, expect, afterEach } from "vitest";
import {
  parseCredentialsFromHeaders,
  parseCredentialsFromEnv,
  loadEnvironmentConfig,
  validateCredentials,
} from "./config.js";

const ENV_KEYS = [
  "SALESFORCE_AUTH_FLOW",
  "SALESFORCE_CLIENT_ID",
  "SALESFORCE_CLIENT_SECRET",
  "SALESFORCE_USERNAME",
  "SALESFORCE_PASSWORD",
  "SALESFORCE_TOKEN",
  "SALESFORCE_INSTANCE_URL",
  "MCP_TRANSPORT",
  "LOG_LEVEL",
  "AUTH_MODE",
  "PORT",
  "HOST",
  "BUILD_VERSION",
  "BUILD_COMMIT_SHA",
  "BUILD_DATE",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("parseCredentialsFromHeaders", () => {
  it("defaults authFlow to client_credentials and reads lowercase headers", () => {
    const creds = parseCredentialsFromHeaders({
      "x-salesforce-client-id": "cid",
      "x-salesforce-client-secret": "csecret",
      "x-salesforce-instance-url": "https://my-org.my.salesforce.com",
    });

    expect(creds).toEqual({
      authFlow: "client_credentials",
      clientId: "cid",
      clientSecret: "csecret",
      username: undefined,
      password: undefined,
      securityToken: undefined,
      instanceUrl: "https://my-org.my.salesforce.com",
    });
  });

  it("switches to username_password only on an exact match", () => {
    expect(
      parseCredentialsFromHeaders({ "x-salesforce-auth-mode": "username_password" }).authFlow,
    ).toBe("username_password");
    expect(
      parseCredentialsFromHeaders({ "x-salesforce-auth-mode": "USERNAME_PASSWORD" }).authFlow,
    ).toBe("client_credentials");
    expect(
      parseCredentialsFromHeaders({ "x-salesforce-auth-mode": "bogus" }).authFlow,
    ).toBe("client_credentials");
  });

  it("reads username/password/securityToken headers for the username_password flow", () => {
    const creds = parseCredentialsFromHeaders({
      "x-salesforce-auth-mode": "username_password",
      "x-salesforce-username": "user@example.com",
      "x-salesforce-password": "hunter2",
      "x-salesforce-token": "SECTOK",
    });

    expect(creds).toMatchObject({
      authFlow: "username_password",
      username: "user@example.com",
      password: "hunter2",
      securityToken: "SECTOK",
    });
  });

  it("takes the first value when a header arrives as an array (as node's IncomingMessage does for repeated headers)", () => {
    const creds = parseCredentialsFromHeaders({
      "x-salesforce-client-id": ["cid-1", "cid-2"],
    });
    expect(creds.clientId).toBe("cid-1");
  });

  it("leaves fields undefined when the corresponding header is absent", () => {
    const creds = parseCredentialsFromHeaders({});
    expect(creds).toEqual({
      authFlow: "client_credentials",
      clientId: undefined,
      clientSecret: undefined,
      username: undefined,
      password: undefined,
      securityToken: undefined,
      instanceUrl: undefined,
    });
  });
});

describe("parseCredentialsFromEnv", () => {
  it("reads all SALESFORCE_* env vars and defaults authFlow to client_credentials", () => {
    process.env.SALESFORCE_CLIENT_ID = "cid";
    process.env.SALESFORCE_CLIENT_SECRET = "csecret";
    process.env.SALESFORCE_INSTANCE_URL = "https://my-org.my.salesforce.com";
    delete process.env.SALESFORCE_AUTH_FLOW;

    const creds = parseCredentialsFromEnv();

    expect(creds).toEqual({
      authFlow: "client_credentials",
      clientId: "cid",
      clientSecret: "csecret",
      username: undefined,
      password: undefined,
      securityToken: undefined,
      instanceUrl: "https://my-org.my.salesforce.com",
    });
  });

  it("switches to username_password only on an exact env value match", () => {
    process.env.SALESFORCE_AUTH_FLOW = "username_password";
    expect(parseCredentialsFromEnv().authFlow).toBe("username_password");

    process.env.SALESFORCE_AUTH_FLOW = "something_else";
    expect(parseCredentialsFromEnv().authFlow).toBe("client_credentials");
  });
});

describe("loadEnvironmentConfig", () => {
  it("defaults to http transport, info logging, gateway auth, port 8080, host 0.0.0.0", () => {
    delete process.env.MCP_TRANSPORT;
    delete process.env.LOG_LEVEL;
    delete process.env.AUTH_MODE;
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.BUILD_VERSION;
    delete process.env.BUILD_COMMIT_SHA;
    delete process.env.BUILD_DATE;

    const cfg = loadEnvironmentConfig();

    expect(cfg).toEqual({
      authMode: "gateway",
      transport: { type: "http", port: 8080, host: "0.0.0.0" },
      logging: { level: "info" },
      build: { version: "unknown", commitSha: "unknown", buildDate: "unknown" },
    });
  });

  it("switches to stdio transport only on an exact match", () => {
    process.env.MCP_TRANSPORT = "stdio";
    expect(loadEnvironmentConfig().transport.type).toBe("stdio");

    process.env.MCP_TRANSPORT = "sse";
    expect(loadEnvironmentConfig().transport.type).toBe("http");
  });

  it("switches to env auth mode only on an exact match", () => {
    process.env.AUTH_MODE = "env";
    expect(loadEnvironmentConfig().authMode).toBe("env");

    process.env.AUTH_MODE = "gateway-ish";
    expect(loadEnvironmentConfig().authMode).toBe("gateway");
  });

  it("accepts debug/warn/error log levels case-insensitively and falls back to info for anything else", () => {
    process.env.LOG_LEVEL = "DEBUG";
    expect(loadEnvironmentConfig().logging.level).toBe("debug");

    process.env.LOG_LEVEL = "WARN";
    expect(loadEnvironmentConfig().logging.level).toBe("warn");

    process.env.LOG_LEVEL = "error";
    expect(loadEnvironmentConfig().logging.level).toBe("error");

    process.env.LOG_LEVEL = "verbose";
    expect(loadEnvironmentConfig().logging.level).toBe("info");
  });

  it("parses PORT as a number and passes through HOST and build metadata", () => {
    process.env.PORT = "9090";
    process.env.HOST = "127.0.0.1";
    process.env.BUILD_VERSION = "1.2.3";
    process.env.BUILD_COMMIT_SHA = "abc123";
    process.env.BUILD_DATE = "2026-08-28";

    const cfg = loadEnvironmentConfig();

    expect(cfg.transport.port).toBe(9090);
    expect(cfg.transport.host).toBe("127.0.0.1");
    expect(cfg.build).toEqual({
      version: "1.2.3",
      commitSha: "abc123",
      buildDate: "2026-08-28",
    });
  });
});

describe("validateCredentials", () => {
  it("client_credentials: returns no problems when clientId/clientSecret/instanceUrl are all present", () => {
    expect(
      validateCredentials({
        authFlow: "client_credentials",
        clientId: "c",
        clientSecret: "s",
        instanceUrl: "https://x",
      }),
    ).toEqual([]);
  });

  it("client_credentials: reports each missing field independently", () => {
    expect(validateCredentials({ authFlow: "client_credentials" })).toEqual([
      "clientId missing (X-Salesforce-Client-Id)",
      "clientSecret missing (X-Salesforce-Client-Secret)",
      "instanceUrl missing (X-Salesforce-Instance-Url) — required for Client Credentials Flow",
    ]);

    expect(
      validateCredentials({ authFlow: "client_credentials", clientId: "c", clientSecret: "s" }),
    ).toEqual([
      "instanceUrl missing (X-Salesforce-Instance-Url) — required for Client Credentials Flow",
    ]);
  });

  it("username_password: returns no problems when username/password are present (instanceUrl and securityToken optional)", () => {
    expect(
      validateCredentials({ authFlow: "username_password", username: "u", password: "p" }),
    ).toEqual([]);
  });

  it("username_password: reports missing username and/or password", () => {
    expect(validateCredentials({ authFlow: "username_password" })).toEqual([
      "username missing (X-Salesforce-Username)",
      "password missing (X-Salesforce-Password)",
    ]);
    expect(
      validateCredentials({ authFlow: "username_password", username: "u" }),
    ).toEqual(["password missing (X-Salesforce-Password)"]);
  });
});
