# All-Monitor

万能监控站点

## 本地运行

1. 启动后端

```bash
cd server
cp .env.example .env
go run ./cmd/app
```

如果本机未启动 PostgreSQL，可在 `server/.env` 设置：

```bash
DB_DRIVER=sqlite
SQLITE_DSN=data/all-monitor.db
```

2. 启动前端

```bash
cd web
cp .env.example .env
npm install
npm run dev
```