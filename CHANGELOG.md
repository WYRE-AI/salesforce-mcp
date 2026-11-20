# Changelog

This file is maintained by hand. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

### Added
- Initial release. Streamable-HTTP MCP server backed by `jsforce` 3.x with two auth flows (OAuth Client Credentials + Username/Password) and per-request credential injection from `X-Salesforce-*` headers for the WYRE Gateway BYOC pattern. Six CRM tools shipped: `salesforce_search_objects`, `salesforce_describe_object`, `salesforce_query_records`, `salesforce_aggregate_query`, `salesforce_dml_records`, `salesforce_search_all`. Apex / EXECUTE_ANONYMOUS / custom-object-creation surfaces deliberately not shipped — scope-fit to CRM data, not DX/admin. Health probe at `/health` returns build metadata + auth-mode + transport. Container default: HTTP on `:8080`, single-instance always-warm to match the gateway sidecar pattern.
