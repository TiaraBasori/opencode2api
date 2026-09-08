# 💻 开发指南

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

---

## 📋 环境准备

### Node.js 环境

```bash
# Node.js 18+
node --version

# npm
npm --version
```

### 安装依赖

```bash
npm install
```

### 安装 OpenCode CLI

```bash
# Windows
npm install -g opencode-ai

# Linux/macOS
curl -fsSL https://opencode.ai/install | bash
```

---

## 🚀 开发模式

### 启动开发服务器

```bash
# 开发（tsx watch，直接跑 TS 源码 index.ts）
npm run dev

# 生产（先构建再跑产物 dist/index.js）
npm run build
npm start
```

> 这将自动启动 OpenCode 后端 (如果需要) 并启动代理服务。

### 配置本地 config.json

```bash
cp config.json.example config.json
```

---

## ✅ 测试

| 命令 | 说明 |
|:-----|:-----|
| `npm run dev` | 开发模式（tsx watch `index.ts`） |
| `npm run typecheck` | 类型检查（`tsc --noEmit`） |
| `npm run build` | 构建到 `dist/`（入口 `dist/index.js`） |
| `npm start` | 生产启动（`node dist/index.js`） |
| `npm test -- --runInBand` | 运行所有测试 |
| `npm run test:unit` | 运行单元测试 |
| `npm run test:integration` | 运行集成测试 |

### Docker 测试

```bash
# 构建并运行
docker compose up -d --build

# 查看日志
docker compose logs -f
```

---

## 📝 代码规范

### 格式化

项目使用 ESLint (如有配置):

```bash
npm run lint
```

### 提交规范

使用 Conventional Commits:

```
feat: add new feature
fix: fix bug
docs: update documentation
refactor: refactor code
test: add tests
chore: update build/ci
```

---

## 📂 项目结构

```
OpenCode2API/
├── index.ts            # 入口（TS 源码）
├── src/**/*.ts         # 核心代理逻辑（TS）
├── dist/               # 构建产物（tsc 输出，运行时入口 dist/index.js，不进 git）
├── tests/
│   ├── app.test.js       # 单元测试
│   ├── test-integration.sh   # 集成测试
│   └── test-streaming-real.sh # 流式测试
├── docs/                 # 文档
├── package.json         # 项目配置
├── Dockerfile           # Docker 镜像（多阶段：builder -> runtime）
└── docker-compose.yml   # Docker Compose
```

---

## 🔄 贡献流程

1. ⭐ Fork 项目
2. 🌿 创建功能分支: `git checkout -b feature/your-feature`
3. 💾 提交更改: `git commit -m 'feat: add new feature'`
4. 📤 推送分支: `git push origin feature/your-feature`
5. 🔀 创建 Pull Request

---

## 📄 许可证

MIT License - 详见 [LICENSE](../LICENSE.md)
