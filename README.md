# salesforce-mcp

> MCP (Model Context Protocol) server for Salesforce CRM, scoped to the WYRE Gateway BYOC use case.

A focused HTTP MCP server that exposes a Salesforce org's CRM data surface to Claude (and other MCP clients) through the [WYRE MCP Gateway](https://mcp.wyre.ai/). Built for the multi-tenant gateway pattern: credentials are injected per-request via HTTP headers, no startup secrets are baked into the container.

## Scope discipline

This package intentionally ships a **narrow tool surface** — six CRM data tools — and deliberately omits the Apex code-management / custom-object-creation / EXECUTE_ANONYMOUS surfaces that broader Salesforce MCP servers include. The use case is read/write access to standard CRM objects (Accounts, Contacts, Opportunities, Leads, Cases). Customers who need DX or admin tooling should use the official `@salesforce/mcp` package instead.

## Tools

| Tool | Purpose |
| --- | --- |
| `salesforce_search_objects` | Find standard + custom objects by partial name. |
| `salesforce_describe_object` | Full schema (fields, picklists, relationships) for an object. |
| `salesforce_query_records` | Execute SOQL with relationship traversal. |
| `salesforce_aggregate_query` | SOQL GROUP BY / COUNT / SUM / AVG / MIN / MAX. |
| `salesforce_dml_records` | Insert / update / delete / upsert records. |
| `salesforce_search_all` | Cross-object SOSL search. |

## Run modes

- **`http` (default)**: listens on `:8080`, exposes `/mcp` (JSON-RPC) + `/health`. Per-request credentials from `X-Salesforce-*` headers. This is the gateway deployment shape. HTTP refuses to start unless `CONDUIT_S2S_SECRET` is a real secret.
- **`stdio`**: traditional MCP client transport (Claude Desktop / Cursor). Credentials read once from env. The stdio transport does not use `CONDUIT_S2S_SECRET`.

Copy [`.env.example`](.env.example) and set the variables below. Leave `CONDUIT_S2S_SECRET` empty in that file.

| Variable | Required | Description |
| --- | --- | --- |
| `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` / `SALESFORCE_INSTANCE_URL` | For stdio and `AUTH_MODE=env` | Client Credentials flow. |
| `SALESFORCE_USERNAME` / `SALESFORCE_PASSWORD` / `SALESFORCE_TOKEN` | For username-password | Used when `SALESFORCE_AUTH_FLOW=username_password`. The token is optional if the org uses IP allowlisting. |
| `MCP_TRANSPORT` | No | `http` (default) or `stdio`. |
| `AUTH_MODE` | No | `gateway` (image and Compose default) or `env`. Gateway mode requires the `X-Salesforce-*` headers on each `/mcp` request and never falls back to `SALESFORCE_*`. `env` uses those variables only after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. HTTP logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `placeholder`, `your-s2s-secret`, `secret`, `password`, `test`, an unresolved `${...}` template, and the other stand-ins in `src/s2s-verify.ts`). Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not check `X-Gateway-S2S`, and listens on `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` is ignored and the override is logged. A known placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a usable `CONDUIT_S2S_SECRET` is set. When unset, a configured secret keeps `HOST` (default `0.0.0.0`). Without a usable secret the listener is `127.0.0.1`. The container image sets `0.0.0.0`. |
| `PORT` | No | HTTP port. Defaults to `8080`. |
| `HOST` | No | Fallback bind address when `MCP_HTTP_HOST` is unset and a secret is configured. Defaults to `0.0.0.0`. |

`/health` stays unauthenticated and does not read credentials.

```bash
# HTTP mode (exits unless CONDUIT_S2S_SECRET is a real secret)
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" PORT=8080 MCP_TRANSPORT=http AUTH_MODE=gateway npm start

# Local HTTP only, without a service-to-service secret (always binds 127.0.0.1)
MCP_ALLOW_INSECURE_DEV=1 MCP_TRANSPORT=http npm start

# stdio mode (env-baked, local testing; no S2S secret)
MCP_TRANSPORT=stdio \
SALESFORCE_AUTH_FLOW=client_credentials \
SALESFORCE_CLIENT_ID=... SALESFORCE_CLIENT_SECRET=... \
SALESFORCE_INSTANCE_URL=https://yourorg.my.salesforce.com \
node dist/entry.js
```

## Header contract (gateway mode)

Every `/mcp` request must include a valid `X-Gateway-S2S` header when `CONDUIT_S2S_SECRET` is set. Gateway mode also requires the credential headers for the chosen flow. A request missing them returns `401` and does not fall back to `SALESFORCE_*` in the process environment.

| Header | Required? | Notes |
| --- | --- | --- |
| `X-Gateway-S2S` | Yes when the S2S secret is set | `t=<unix seconds>,v1=<hex hmac-sha256>`. See [X-Gateway-S2S signing](#x-gateway-s2s-signing). |
| `X-Salesforce-Auth-Mode` | optional | `client_credentials` (default) or `username_password`. |
| `X-Salesforce-Client-Id` | for client_credentials | Connected App consumer key. |
| `X-Salesforce-Client-Secret` | for client_credentials | Connected App consumer secret. |
| `X-Salesforce-Instance-Url` | for client_credentials | Customer's My Domain URL (e.g. `https://acmecorp.my.salesforce.com`). |
| `X-Salesforce-Username` | for username_password | Salesforce user. |
| `X-Salesforce-Password` | for username_password | Salesforce password. |
| `X-Salesforce-Token` | for username_password | Security token (required unless IP allowlisted). |

Per-request authentication means the same container instance can service many customers without restart — each MCP `tools/call` builds a fresh `jsforce.Connection` from the headers on that request.

### X-Gateway-S2S signing

`v1` is HMAC-SHA256, hex-encoded, of the ASCII string `t=<unix seconds>` (the same `t=` prefix that starts the header), keyed with `CONDUIT_S2S_SECRET`. The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns HTTP 401. The secret is never written to logs or the response body.

```bash
t=$(date +%s)
v1=$(printf 't=%s' "$t" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "X-Gateway-S2S: t=${t},v1=${v1}" \
  -H "X-Salesforce-Client-Id: ..." \
  -H "X-Salesforce-Client-Secret: ..." \
  -H "X-Salesforce-Instance-Url: https://yourorg.my.salesforce.com" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Salesforce Connected App setup

For Client Credentials flow (the recommended path):

1. Salesforce Setup → App Manager → New Connected App.
2. Under **API (Enable OAuth Settings)**: turn on **Enable OAuth Settings** and **Enable Client Credentials Flow**.
3. Save, wait ~5 minutes for propagation.
4. Manage → Edit Policies → Client Credentials Flow → set a **Run As** user (the API calls run with that user's permissions).
5. Copy the Consumer Key and Consumer Secret from the Connected App into the gateway BYOC fields as `clientId` and `clientSecret`.
6. Set `instanceUrl` to the customer's My Domain URL (Setup → My Domain).

## Build

```bash
npm install
npm run build
```

## Container

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode, Salesforce credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t salesforce-mcp:dev .
docker run --rm \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  salesforce-mcp:dev
curl -s http://127.0.0.1:8080/health
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not inject `SALESFORCE_*`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `SALESFORCE_*`:

```bash
docker run --rm \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e SALESFORCE_AUTH_FLOW=client_credentials \
  -e SALESFORCE_CLIENT_ID=your-value \
  -e SALESFORCE_CLIENT_SECRET=your-value \
  -e SALESFORCE_INSTANCE_URL=https://yourorg.my.salesforce.com \
  -p 127.0.0.1:8080:8080 \
  salesforce-mcp:dev
```

The published image lives at `ghcr.io/wyre-ai/salesforce-mcp` with `:latest`, `:sha-<short_sha>`, and `:v<version>` tags.

## License

Apache-2.0.
