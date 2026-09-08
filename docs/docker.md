# 🐳 Docker 部署

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

---

## 🚀 快速开始

### 1️⃣ 克隆项目

```bash
git clone https://github.com/samson910022/OpenCode2API.git
cd OpenCode2API
```

### 2️⃣ 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，设置你的配置
```

### 3️⃣ 启动服务

```bash
docker compose up -d
```

### 4️⃣ 验证

```bash
# 健康检查
curl http://127.0.0.1:10000/health

# 获取模型列表
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

---

## ⚙️ 配置说明

### .env 文件

```env
# 必需配置
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# 安全相关
DISABLE_TOOLS=true

# 可选配置
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

---

## 📦 卷挂载

| 卷名 | 容器内路径 | 说明 |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode 数据目录 |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode 配置目录 |
| 项目目录 | `/home/node/project` | 项目源代码 |

---

## 🔨 自定义构建

### 构建镜像

```bash
docker build -t my-opencode2api .
```

### 运行单个容器

```bash
docker run -d \
  -p 10000:10000 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  my-opencode2api
```

> 后端 `10001` 仅容器内部使用，不要对外发布（compose 默认也只映射代理端口；改端口用 `OPENCODE_PROXY_PORT`，如 `8090`）。

### 多架构

`ghcr.io/samson910022/opencode2api:latest` 同时含 `linux/amd64` 与 `linux/arm64`，ARM 机器可直接 pull，无需本地 build（仅自带 `custom-bin/opencode` 二进制时才需按架构重建）。

### 覆寫資源限制

compose 預設 `mem_limit 768m`（單容器含 proxy＋後端）。大機要放寬或取消，用 override 檔：

```yaml
# docker-compose.override.yml
services:
  opencode2api:
    mem_limit: 2g
    mem_reservation: 512m
    cpus: 4.0
```

---

## 📊 日志管理

compose 已内置 json-file 轮转（`max-size: 10m`、`max-file: 3`）；裸 `docker run` 请自行加上 `--log-opt max-size=10m --log-opt max-file=3`。

### 查看日志

```bash
docker compose logs -f
```

---

## ✅ 健康检查

服务配置了健康检查:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:${OPENCODE_PROXY_PORT:-10000}/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 200s
```

> `/health` 是浅检查（只确认代理活着，不测后端；`start_period` 200s 覆盖 entrypoint 约 180s 的小机冷启动等待）。小机（1GB）另有 `mem_limit 768m` / `pids_limit 256` 保护，裸 `docker run` 请加等价旗（见 `docker-compose.yml` 注释）。

---

## ❓ 常见问题

### 容器无法启动

检查日志:
```bash
docker compose logs
```

### 挂载权限问题

确保 PUID/PGID 配置正确 (默认 1000:1000)。
