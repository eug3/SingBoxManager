# syntax=docker/dockerfile:1
# vault-edit 整包镜像：Angular 管理台 + Monaco 静态 + Go 服务 + sing-box 编译器
# 构建上下文必须是仓库根目录：  docker build -t sbm/vault-edit .
# 运行（compose）：            cp .env.example .env && 填 VAULT_KEY && docker compose up -d --build
# 说明见 docs/deploy.md §11。

# —— 可覆盖的全局构建参数 ——
ARG NODE_IMAGE=node:24-alpine
ARG GO_IMAGE=golang:1.27-alpine
# sing-box 版本务必 ≤ 路由侧版本（.srs 二进制格式随版本演进，编译器过新路由可能加载失败；
# 路由 1.15(alpha) 可加载 1.14 稳定版产物）。要精确对齐时填完整 tag，如 1.15.0-alpha.13；
# 官方 ghcr 镜像只发 latest 无法钉版本，故从 GitHub Releases 拉固定版本二进制
ARG SINGBOX_VERSION=1.14.4
ARG GH_PROXY=""
ARG MONACO_VERSION=0.57.0

# ————————————————— 1. Angular 管理台（等价 deploy_console.sh 的 ng build） —————————————————
FROM ${NODE_IMAGE} AS console
WORKDIR /build
COPY web/console/package.json web/console/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/console/ ./
RUN npx ng build --base-href=/edit/

# ————————————————— 2. Monaco 静态资源（等价 deploy_console.sh 的 min/vs 铺设） —————————————————
# 注意：npm 包里没有 package/min/vs 目录条目（只有其下文件），tar 按名提取目录会失败，
# 所以先整体解压再挪位置（与 deploy_console.sh 的做法一致）
FROM ${NODE_IMAGE} AS monaco
ARG MONACO_VERSION
WORKDIR /tmp
RUN npm pack monaco-editor@${MONACO_VERSION} \
 && mkdir -p ext \
 && tar xzf monaco-editor-${MONACO_VERSION}.tgz -C ext \
 && mkdir -p out \
 && mv ext/package/min/vs out/vs

# ————————————————— 3. Go 服务（等价 deploy_service.sh 的交叉编译参数） —————————————————
FROM ${GO_IMAGE} AS service
WORKDIR /src
COPY service/go.mod service/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY service/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/vault-edit .

# ————————————————— 4. sing-box 二进制（/publish 编译 .srs 用，版本可钉死） —————————————————
# 运行时是 Alpine(musl)：官方默认构建链接 glibc 会报 no such file or directory，
# 必须用 -musl 变体（包内目录 strip 后二进制名就是 sing-box）
FROM alpine:3.22 AS singbox
ARG SINGBOX_VERSION
ARG GH_PROXY
ARG TARGETARCH
RUN apk add --no-cache curl \
 && curl -fL --retry 3 -o /tmp/sb.tar.gz \
      "${GH_PROXY:+$GH_PROXY/}https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${TARGETARCH}-musl.tar.gz" \
 && tar xzf /tmp/sb.tar.gz -C /tmp --strip-components=1 \
 && install -m 0755 /tmp/sing-box /usr/local/bin/sing-box \
 && /usr/local/bin/sing-box version | head -1

# ————————————————— 5. 运行时 —————————————————
FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata

COPY --from=service /out/vault-edit          /usr/local/bin/vault-edit
COPY --from=singbox /usr/local/bin/sing-box  /usr/local/bin/sing-box
COPY --from=console /build/dist/console/browser /usr/local/share/vault-edit/edit
COPY --from=monaco  /tmp/out/vs                /usr/local/share/vault-edit/static/monaco/vs

# 非 root 运行；数据目录（SQLite、local 模式规则桶）交给卷
RUN addgroup -S vault && adduser -S -G vault vault \
 && mkdir -p /var/lib/vault-edit /usr/local/share/vault-edit/rule-set \
 && chown -R vault:vault /var/lib/vault-edit /usr/local/share/vault-edit/rule-set

# 环境变量口径与 docs/deploy.md §2 的表格一致（VAULT_KEY 必填，运行时注入，不进镜像）
ENV LISTEN=:9099 \
    FILES_LISTEN=:9098 \
    PAGE_DIR=/usr/local/share/vault-edit/edit \
    STATIC_DIR=/usr/local/share/vault-edit/static \
    SINGBOX=/usr/local/bin/sing-box \
    DB_FILE=/var/lib/vault-edit/sbm.db \
    ROUTERS_FILE=/var/lib/vault-edit/routers.json \
    LOGIN_FILE=/var/lib/vault-edit/login.json \
    SINGBOX_CACHE=/var/lib/vault-edit/singbox \
    SHARE_CONFIG=/var/lib/vault-edit/share.json \
    SHARE_MODE=local \
    SHARE_LOCAL_DIR=/usr/local/share/vault-edit/rule-set

USER vault
VOLUME ["/var/lib/vault-edit", "/usr/local/share/vault-edit/rule-set"]
EXPOSE 9099 9098
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9099/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/vault-edit"]
