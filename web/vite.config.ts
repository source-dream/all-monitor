import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import net from 'node:net'

function parseAllowedHosts(raw: string | undefined): string[] {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return Array.from(new Set(items))
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function findDevPort(startPort: number, maxOffset: number): Promise<number> {
  for (let i = 0; i <= maxOffset; i += 1) {
    const candidate = startPort + i
    // 自动探测可用端口，避免多个前端项目抢占 5173。
    if (await isPortAvailable(candidate)) {
      return candidate
    }
  }
  return startPort
}

// https://vite.dev/config/
export default defineConfig(async () => {
  const preferredPort = Number(process.env.PORT ?? 5173)
  const devPort = await findDevPort(preferredPort, 20)
  const proxyTarget = process.env.VITE_DEV_API_PROXY_TARGET ?? 'http://127.0.0.1:8080'
  const allowedHosts = parseAllowedHosts(process.env.VITE_DEV_ALLOWED_HOSTS)

  return {
    plugins: [react()],
    build: {
      outDir: '../server/internal/webstatic/dist',
      emptyOutDir: false,
    },
    server: {
      host: true,
      port: devPort,
      strictPort: true,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/sdk': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
