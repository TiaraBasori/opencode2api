# 🔧 故障排查

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
</p>

---

## ❓ 常见问题

### 1️⃣ 请求卡住

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 模型列表接口正常，但实际请求无响应 |
| **解决方案** | 设置 `USE_ISOLATED_HOME=false` 让 OpenCode 复用本机登录态 |

```bash
USE_ISOLATED_HOME=false
# 或
OPENCODE_USE_ISOLATED_HOME=false
```

---

### 2️⃣ 模型不存在

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 返回 `model_not_found` 错误 |
| **解决方案** | 检查可用模型列表，确认模型 ID 正确 |

```bash
curl http://127.0.0.1:10000/v1/models
```

---

### 3️⃣ 没有推理输出

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 发送了 `reasoning_effort` 但没有推理输出 |
| **解决方案** | 使用 `stream: true` 的 Responses API |

---

### 4️⃣ 工具调用意外触发

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 客户端意外触发了 OpenCode 工具调用 |
| **解决方案** | 保持 `DISABLE_TOOLS=true` |

---

### 5️⃣ 端口冲突

| 项目 | 说明 |
|:-----|:-----|
| **症状** | `Error: listen EADDRINUSE: address already in use` |
| **解决方案** | 更改端口或检查端口占用 |

```bash
# 检查端口占用
lsof -i :10000
lsof -i :10001

# 更改端口
OPENCODE_PROXY_PORT=10002
OPENCODE_SERVER_PORT=10003
```

---

### 6️⃣ OpenCode 未安装

| 项目 | 说明 |
|:-----|:-----|
| **症状** | `Cannot verify OpenCode installation` |
| **解决方案** | 安装 OpenCode CLI |

```bash
# Windows
npm install -g opencode-ai

# Linux/macOS
curl -fsSL https://opencode.ai/install | bash
```

---

### 7️⃣ Docker 容器无法启动

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 容器启动失败或立即退出 |
| **解决方案** | 检查日志和配置 |

```bash
# 查看日志
docker compose logs

# 检查端口
netstat -tulpn | grep -E '10000|10001'
```

---

### 8️⃣ 认证失败

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 返回 `401 Unauthorized` |
| **解决方案** | 确认 `API_KEY` 配置正确 |

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" ...
```

---

## 🔍 调试模式

开启调试日志:

```bash
# 环境变量
DEBUG=true
# 或
OPENCODE_PROXY_DEBUG=true
```

调试日志会输出详细的请求和响应信息。

---

## 🆘 获取帮助

- 🐛 [GitHub Issues](https://github.com/TiaraBasori/opencode2api/issues)