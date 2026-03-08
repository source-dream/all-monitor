# All Monitor

All Monitor 是一个开源的监控系统，提供统一的界面和 API 来监控各种类型的资源，包括网站、API、TCP 服务和订阅等。

目前测速是基于 sing-box 需要本地环境有 sing-box 内核

## 快速开始

### 二进制文件

前往 [Release](https://github.com/source-dream/all-monitor/releases) 下载最新版本

解压之后运行二进制可执行程序即可，首次运行会生成一个默认的配置文件

```
chmod +x ./all-monitor
./all-monitor
```
编辑文件 `/etc/systemd/system/all-monitor.service`

```
[Unit]
Description=All Monitor Service
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=/app/all-monitor
ExecStart=/app/all-monitor/all-monitor
Restart=always
RestartSec=5
User=<用户名>
Group=<用户名>
[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
systemctl enable --now all-monitor.service
```

### 配置文件解析

程序读取当前工作目录下的 `.env`。推荐使用下面这种“模板 + 注释”方式配置：

```env
# 服务监听端口（Docker -p 左右端口建议保持一致）
APP_PORT=8317

# 数据库类型：sqlite / postgres
DB_DRIVER=sqlite

# SQLite 文件路径（Docker 推荐持久化目录）
SQLITE_DSN=/var/lib/all-monitor/all-monitor.db

# PostgreSQL 配置（仅 DB_DRIVER=postgres 时生效）
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASS=postgres
DB_NAME=all_monitor

# JWT 密钥（必填，生产环境请替换为强随机字符串）
JWT_SECRET=replace_with_strong_secret

# CORS 白名单：多个来源用逗号分隔，auto 表示自动放行局域网来源
# 示例：CORS_ALLOW=https://monitor.example.com,https://admin.example.com,auto
CORS_ALLOW=auto

# 离线 IP 归属地数据库路径（可选，不存在时会自动降级）
IP_REGION_DB=/var/lib/all-monitor/ip2region.xdb
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

## 首次运行默认配置

- 程序启动时如果当前目录不存在 `.env`，会自动生成默认配置。
- 自动生成的 `.env` 会包含随机 `JWT_SECRET`，可直接启动。
- 如需自定义端口、数据库等配置，按需修改 `.env`。
