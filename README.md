# All-Monitor

源梦监控（Go + React）。

## 开发模式

### 一键启动前后端

```bash
make dev
```

停止开发进程：

```bash
make dev-stop
```

### 分别启动

后端：

```bash
cd server
cp .env.example .env
go run ./cmd/app
```

前端：

```bash
cd web
npm install
npm run dev
```

## 一体化构建（前后端整合单可执行文件）

```bash
make build
```

构建完成后运行：

```bash
./bin/all-monitor
```

说明：
- 前端构建产物会输出到 `server/internal/webstatic/dist`
- Go 通过 `embed` 内嵌静态文件，运行时同进程提供 `/` 和 `/api/*`
- 服务启动后会自动将历史类型规范化：`http->site`、`api->ai`、`tcp/server/node->port`

## 跨平台构建说明

同一个二进制不能同时在 Linux 和 Windows 运行，需要分别构建：

```bash
make build-linux
make build-windows
```

产物：
- `bin/all-monitor-linux-amd64`
- `bin/all-monitor-windows-amd64.exe`

注意：项目使用 `go-sqlite3`（CGO），Windows 交叉编译需要本机安装 `x86_64-w64-mingw32-gcc`。
如果缺少该工具链，建议在 Windows 环境本机构建。

## 常用命令

```bash
make web-build      # 仅构建前端
make server-build   # 仅构建后端可执行文件
make build-linux    # 构建 Linux amd64 发布包
make build-windows  # 构建 Windows amd64 发布包（需 mingw）
make release        # 生成 release 压缩包 + SHA256 清单
make test           # 后端构建 + 前端构建
make clean          # 清理 bin
```

`make release` 会执行 `scripts/release.sh`，默认输出到 `dist/`：
- `all-monitor-<version>-linux-amd64.tar.gz`
- `all-monitor-<version>-windows-amd64.zip`（若本机有 mingw）
- `SHA256SUMS-<version>.txt`

版本号策略：
- 若传入 `VERSION`，优先使用（例如 `VERSION=v0.1.0 make release`）
- 否则自动读取 Git：`HEAD tag` -> `latest tag + short sha` -> `snapshot-shortsha`
- 工作区有未提交改动时会追加 `-dirty`

## CI 自动发布（GitHub + Gitea）

已提供两个工作流：
- `.github/workflows/release.yml`
- `.gitea/workflows/release.yml`

触发条件：
- 推送 tag（如 `v0.1.0`）后自动触发。

发布产物：
- `all-monitor-<tag>-linux-amd64.tar.gz`
- `all-monitor-<tag>-windows-amd64.zip`
- `SHA256SUMS-<tag>.txt`

说明：
- 产物由 `scripts/ci-release-package.sh` 统一生成，内部调用 `scripts/release.sh`，并将 `VERSION` 固定为当前 tag。
- GitHub 发布使用 `GITHUB_TOKEN`（默认可用）。
- Gitea 发布需要仓库密钥 `GITEA_TOKEN`（需有 release 写权限）。
