FROM node:20-bookworm-slim AS web-builder

WORKDIR /src

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY web ./web
COPY server ./server

RUN npm --prefix web run build

FROM golang:1.23-bookworm AS server-builder

WORKDIR /src/server

RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server ./
COPY --from=web-builder /src/server/internal/webstatic/dist ./internal/webstatic/dist

RUN CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -o /out/all-monitor ./cmd/app

FROM debian:bookworm-slim AS singbox-builder

ARG SING_BOX_VERSION=v1.13.2
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
	case "${TARGETARCH}" in \
		""|amd64) sb_arch="amd64" ;; \
		arm64) sb_arch="arm64" ;; \
		*) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	version="${SING_BOX_VERSION#v}"; \
	url="https://github.com/SagerNet/sing-box/releases/download/${SING_BOX_VERSION}/sing-box-${version}-linux-${sb_arch}.tar.gz"; \
	curl -fsSL "$url" -o /tmp/sing-box.tar.gz; \
	tar -xzf /tmp/sing-box.tar.gz -C /tmp; \
	cp "/tmp/sing-box-${version}-linux-${sb_arch}/sing-box" /usr/local/bin/sing-box; \
	chmod +x /usr/local/bin/sing-box

FROM debian:bookworm-slim

WORKDIR /app/all-monitor

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*

COPY --from=server-builder /out/all-monitor ./all-monitor
COPY --from=singbox-builder /usr/local/bin/sing-box /usr/local/bin/sing-box

RUN mkdir -p /var/lib/all-monitor

VOLUME ["/var/lib/all-monitor"]

EXPOSE 8080

CMD ["/app/all-monitor/all-monitor"]
