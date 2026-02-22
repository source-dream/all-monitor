# All Monitor

All Monitor 是一个开源的监控系统，提供统一的界面和 API 来监控各种类型的资源，包括网站、API、TCP 服务和订阅等。

## 使用指南



## 开发指南

一键启动前后端

```bash
make dev
```

一键构建

```bash
make build
```

后端启动

```bash
cd server
cp .env.example .env
go run ./cmd/app
```

前端启动

```bash
cd web
npm install
npm run dev
```

运行构建产物

```bash
./bin/all-monitor
```

跨平台构建

```bash
make build-linux
make build-windows
```

产物：
- `bin/all-monitor-linux-amd64`
- `bin/all-monitor-windows-amd64.exe`

注意：项目使用 `go-sqlite3`（CGO），Windows 交叉编译需要本机安装 `x86_64-w64-mingw32-gcc`。
如果缺少该工具链，建议在 Windows 环境本机构建。

## CI 自动发布（GitHub + Gitea）

- 工作流文件：`.github/workflows/release.yml`、`.gitea/workflows/release.yml`
- 触发条件：push tag（也支持手动触发 `workflow_dispatch`）
- 产物命名：
  - `all-monitor-<tag>-linux-amd64.tar.gz`
  - `all-monitor-<tag>-windows-amd64.zip`
  - `SHA256SUMS-<tag>.txt`
- 发布类型：tag 包含 `-`（如 `v1.0.0-beta.3`）时自动标记为预发布；纯版本号（如 `v1.0.0`）发布为正式版

## 首次运行默认配置

- 程序启动时如果当前目录不存在 `.env`，会自动生成默认配置。
- 自动生成的 `.env` 会包含随机 `JWT_SECRET`，可直接启动。
- 如需自定义端口、数据库等配置，按需修改 `.env`。
