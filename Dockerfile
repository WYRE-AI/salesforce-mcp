# Multi-stage build for the WYRE Gateway salesforce-mcp sidecar.
# Mirrors the autotask-mcp build shape: build stage compiles TS, prod stage
# copies dist + runs as node user.

FROM node:26-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

RUN npm install -g npm@10

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

# Production stage
FROM node:26-alpine AS production

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/salesforce-mcp"
LABEL org.opencontainers.image.title="salesforce-mcp"
LABEL org.opencontainers.image.description="WYRE Gateway Salesforce MCP sidecar — focused CRM tool surface (Accounts, Contacts, Opportunities, Leads, Cases)."
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/salesforce-mcp"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"

RUN npm install -g npm@10

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# Embed build metadata so /health can report it
ENV BUILD_VERSION=${VERSION}
ENV BUILD_COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_DATE=${BUILD_DATE}

# Run as non-root
USER node

# Default HTTP mode for gateway-hosted deployment. Standalone stdio usage
# (for local Claude Desktop testing) can be reached by `node dist/entry.js`
# with MCP_TRANSPORT=stdio.
ENV MCP_TRANSPORT=http
ENV PORT=8080
ENV LOG_LEVEL=info
ENV AUTH_MODE=gateway

EXPOSE 8080

# Lightweight healthcheck against the /health endpoint (gateway probe target).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/entry.js"]
