# All-Monitor Server

## 启动要求

- Go 1.23+
- SQLite（默认）或 PostgreSQL 14+

## 快速开始

1. 复制环境变量

```bash
cp .env.example .env
```

2. 使用默认 SQLite（推荐开发环境）

默认 `DB_DRIVER=sqlite`，无需额外安装数据库。

3. 启动服务

```bash
go run ./cmd/app
```

4. （可选）如需改用 PostgreSQL，再执行数据库初始化

```bash
psql -h 127.0.0.1 -U postgres -d all_monitor -f migrations/001_init.sql
```

如果本机暂时没有 PostgreSQL，可切换为 SQLite（开发模式）：

```bash
# 编辑 .env
DB_DRIVER=sqlite
SQLITE_DSN=data/all-monitor.db
```

> 程序会自动读取 `server/.env`。如未创建 `.env`，会因为缺少 `JWT_SECRET` 启动失败。

## 常见报错

- `dial tcp 127.0.0.1:5432: connect: connection refused`
  - 原因：PostgreSQL 未启动或连接参数错误。
  - 解决 A：启动 PostgreSQL，并确认 `.env` 中 `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME` 正确。
  - 解决 B：将 `.env` 的 `DB_DRIVER` 改为 `sqlite`，先以本地文件数据库启动开发环境。

## 说明

- 首次运行后，请先调用 `POST /api/init/setup` 完成管理员初始化。
- 初始化后，使用 `POST /api/auth/login` 获取 JWT 令牌。
- 受保护接口需要在 `Authorization` 头中传入 `Bearer <token>`。
- 前端跨域地址可通过 `CORS_ALLOW` 配置（默认 `http://localhost:5173`）。
- 如开发机 IP 经常变化，建议配置 `CORS_ALLOW=http://localhost:5173,auto`，自动放行局域网来源。
- 可调用 `POST /api/targets/:id/check-now` 触发立即巡检。
- 可调用 `GET /api/targets/:id/results?limit=100` 查询目标历史结果。

### 离线 IP 归属地（埋点日志）

- 默认读取 `IP_REGION_DB` 指向的离线库文件（如 `data/ip2region.xdb`）。
- 文件不存在时会自动降级，不影响埋点写入，仅日志归属地显示为未知。

## 埋点（Tracking）接入示例

1. 先在控制台创建 `type=tracking` 目标，拿到 `write_key`。
2. `tracking` 是被动上报类型，不需要配置探测地址、间隔、超时。
3. 前端上报接口：`POST /api/ingest/:write_key`（无需 JWT）。
4. 控制台图表会调用：`GET /api/targets/:id/tracking/series?hours=24`。
5. 日志可按窗口查询：`GET /api/targets/:id/tracking/events?limit=500&hours=24`。

UV 去重方式说明（控制台可配置）：

- `client_id`：按客户端标识去重（推荐默认）
- `ip_ua_hash`：按 `IP + User-Agent` 去重
- `ip+client_id`：按 `IP + client_id` 组合去重

### 单事件上报（sendBeacon）

```html
<script>
  (function () {
    const API_BASE = 'http://localhost:8080';
    const WRITE_KEY = '替换为你的write_key';

    function getClientId() {
      const key = 'ym_monitor_cid';
      const cached = localStorage.getItem(key);
      if (cached) return cached;
      const cid = `cid_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(key, cid);
      return cid;
    }

    function track(eventName, extra) {
      const payload = {
        event_name: eventName,
        page: location.pathname,
        client_id: getClientId(),
        occurred_at: Date.now(),
        meta: extra || {},
      };

      const url = `${API_BASE}/api/ingest/${WRITE_KEY}`;
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    }

    track('page_view', { title: document.title });

    document.addEventListener('click', function (e) {
      const target = e.target && e.target.closest ? e.target.closest('[data-track]') : null;
      if (!target) return;
      track('click', { id: target.id || '', text: (target.textContent || '').trim().slice(0, 64) });
    });
  })();
</script>
```

### 批量上报格式

```json
{
  "events": [
    { "event_name": "page_view", "page": "/", "count": 1, "client_id": "c_1", "occurred_at": 1761030975123 },
    { "event_name": "button_click", "page": "/pricing", "count": 1, "client_id": "c_1", "meta": { "btn": "buy" } }
  ]
}
```
