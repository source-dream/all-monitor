# All Monitor

All Monitor 是一个开源的监控系统，提供统一的界面和 API 来监控各种类型的资源，包括网站、API、TCP 服务和订阅等。

目前测速是基于 sing-box 需要

## 快速开始

### 二进制文件

前往 [Release](https://github.com/source-dream/all-monitor/releases) 下载最新版本

解压之后运行即可，首次运行会生成一个默认的配置文件

```
# linux运行方式
chmod +x ./all-monitor
./all-monitor
```

参考systemd配置文件

```
[Unit]
Description=All Monitor Service
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=/app/all-monitor
ExecStart=/app/all-monitor/main
Restart=always
RestartSec=5
User=<用户名>
Group=<用户名>
[Install]
WantedBy=multi-user.target
```

```
systemctl enable --now all-monitor.service
```
### Docker

部署

```docker
docker run -d --name all-monitor --restart unless-stopped -p 8317:8317 -e APP_PORT=8317 -e DB_DRIVER=sqlite -e SQLITE_DSN=/var/lib/all-monitor/all-monitor.db -e JWT_SECRET='请替换为强随机密钥' -e CORS_ALLOW='auto' -v all-monitor-data:/var/lib/all-monitor ghcr.io/source-dream/all-monitor:latest
```

更新

```
docker pull ghcr.io/source-dream/all-monitor:latest && docker rm -f all-monitor && docker run -d --name all-monitor --restart unless-stopped -p 8317:8317 -e APP_PORT=8317 -e DB_DRIVER=sqlite -e SQLITE_DSN=/var/lib/all-monitor/all-monitor.db -e JWT_SECRET='请替换为强随机密钥' -e CORS_ALLOW='auto' -v all-monitor-data:/var/lib/all-monitor ghcr.io/source-dream/all-monitor:latest
```

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

## 首次运行默认配置

- 程序启动时如果当前目录不存在 `.env`，会自动生成默认配置。
- 自动生成的 `.env` 会包含随机 `JWT_SECRET`，可直接启动。
- 如需自定义端口、数据库等配置，按需修改 `.env`。
