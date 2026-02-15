# All-Monitor

万能监控站点

## 本地运行

1. 启动后端

```bash
cd server
cp .env.example .env
go run ./cmd/app
```

可使用PostgreSQL，需要在 `server/.env` 设置

2. 启动前端

```bash
cd web
npm install
npm run dev
```