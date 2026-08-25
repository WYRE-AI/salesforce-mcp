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

- **`http` (default)**: listens on `:8080`, exposes `/mcp` (JSON-RPC) + `/health`. Per-request credentials from `X-Salesforce-*` headers. This is the gateway deployment shape.
- **`stdio`**: traditional MCP client transport (Claude Desktop / Cursor). Credentials read once from env. Useful for local testing.

```bash
# HTTP mode (gateway default)
PORT=8080 MCP_TRANSPORT=http AUTH_MODE=gateway npm start

# stdio mode (env-baked, local testing)
MCP_TRANSPORT=stdio \
SALESFORCE_AUTH_FLOW=client_credentials \
SALESFORCE_CLIENT_ID=... SALESFORCE_CLIENT_SECRET=... \
SALESFORCE_INSTANCE_URL=https://yourorg.my.salesforce.com \
node dist/entry.js
```

## Header contract (gateway mode)

| Header | Required? | Notes |
| --- | --- | --- |
| `X-Salesforce-Auth-Mode` | optional | `client_credentials` (default) or `username_password`. |
| `X-Salesforce-Client-Id` | for client_credentials | Connected App consumer key. |
| `X-Salesforce-Client-Secret` | for client_credentials | Connected App consumer secret. |
| `X-Salesforce-Instance-Url` | for client_credentials | Customer's My Domain URL (e.g. `https://acmecorp.my.salesforce.com`). |
| `X-Salesforce-Username` | for username_password | Salesforce user. |
| `X-Salesforce-Password` | for username_password | Salesforce password. |
| `X-Salesforce-Token` | for username_password | Security token (required unless IP allowlisted). |

Per-request authentication means the same container instance can service many customers without restart — each MCP `tools/call` builds a fresh `jsforce.Connection` from the headers on that request.

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

```bash
docker build -t salesforce-mcp:dev .
docker run --rm -p 8080:8080 -e MCP_TRANSPORT=http salesforce-mcp:dev
curl -s http://localhost:8080/health
```

The published image lives at `ghcr.io/wyre-ai/salesforce-mcp` with `:latest`, `:sha-<short_sha>`, and `:v<version>` tags.

## License

Apache-2.0.
