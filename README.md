# Tencent Docs Markdown CLI & Agent Skill

> 腾讯文档 Markdown 的命令行工具和 Agent Skill，支持通过自然语言创建、上传、下载、删除、编辑腾讯文档 Markdown 文件。

## 使用方法

### 安装

```bash
npm install
```

### 登录

首次使用需要扫码登录，登录后 Cookie 自动缓存，过期时会自动触发重新登录。

```bash
# 扫码登录（缓存有效则跳过）
node src/index.js login

# 强制重新登录
node src/index.js login --force
```

### 命令行使用

```bash
# 创建文档
node src/index.js create "我的笔记"
node src/index.js create "我的笔记" --content "# Hello World"

# 上传本地 .md 文件
node src/index.js upload ./my-notes.md
node src/index.js upload ./my-notes.md --title "自定义标题"

# 下载文档到本地
node src/index.js download https://docs.qq.com/markdown/DQxxxxxxxx
node src/index.js download https://docs.qq.com/markdown/DQxxxxxxxx -o ./output.md

# 删除文档（移至回收站）
node src/index.js delete https://docs.qq.com/markdown/DQxxxxxxxx

# 查看文档内容
node src/index.js read https://docs.qq.com/markdown/DQxxxxxxxx

# 更新文档内容
node src/index.js update https://docs.qq.com/markdown/DQxxxxxxxx "# 新内容"
node src/index.js update https://docs.qq.com/markdown/DQxxxxxxxx ./updated.md

# 重命名文档
node src/index.js rename https://docs.qq.com/markdown/DQxxxxxxxx "新标题"

# 查看文档信息
node src/index.js info https://docs.qq.com/markdown/DQxxxxxxxx
```

### Agent 集成使用

```javascript
const {
  handleCreate,
  handleUpload,
  handleDownload,
  handleDelete,
  handleRead,
  handleUpdate,
  handleRename,
  handleInfo,
  handleLogin,
} = require('./src/index');

// Create
const doc = await handleCreate('My Document', '# Hello');
console.log(doc.docUrl); // https://docs.qq.com/markdown/DQxxxxx

// Upload local file
const uploaded = await handleUpload('./notes.md');

// Download to local
const downloaded = await handleDownload('https://docs.qq.com/markdown/DQxxxxx', './output.md');

// Delete
await handleDelete('https://docs.qq.com/markdown/DQxxxxx');

// Read content
const content = await handleRead('https://docs.qq.com/markdown/DQxxxxx');

// Update content
await handleUpdate('https://docs.qq.com/markdown/DQxxxxx', '# Updated');

// Rename
await handleRename('https://docs.qq.com/markdown/DQxxxxx', 'New Title');
```

## 功能列表

| 功能 | CLI 命令 | 说明 |
|---|---|---|
| 🔐 扫码登录 | `login` | 微信/QQ 扫码登录，Cookie 自动缓存 |
| ➕ 创建文档 | `create <title>` | 创建空白 Markdown 文档 |
| 📤 上传文件 | `upload <file>` | 上传本地 .md 文件到腾讯文档 |
| 📥 下载文档 | `download <url>` | 下载腾讯文档到本地 .md 文件 |
| 🗑️ 删除文档 | `delete <url>` | 删除文档（移至回收站） |
| 📖 读取内容 | `read <url>` | 读取并显示文档内容 |
| ✏️ 更新内容 | `update <url> <content>` | 更新文档内容（支持文本或文件路径） |
| 📝 重命名 | `rename <url> <title>` | 修改文档标题 |
| ℹ️ 文档信息 | `info <url>` | 获取文档元数据 |

## 认证机制

1. **首次使用**：执行任何操作时会自动检测登录状态
2. **未登录/过期**：自动打开浏览器显示腾讯文档登录页面
3. **扫码登录**：使用微信或 QQ 扫描二维码完成登录
4. **Cookie 缓存**：登录成功后 Cookie 保存到 `.cookies.json`
5. **自动续期**：每次操作前检测 Cookie 是否有效，过期则重新扫码

```
操作请求 → 检查 Cookie → 有效 → 执行 API
                        → 无效 → 打开浏览器 → 扫码登录 → 保存 Cookie → 执行 API
```

## 技术栈

- **Node.js** - 运行时
- **Puppeteer** - 浏览器自动化（扫码登录）
- **Axios** - HTTP 请求
- **Commander** - CLI 命令解析
- **Chalk / Ora** - 终端美化输出

## 项目结构

```
tencent-docs-markdown/
├── package.json          # 依赖配置
├── SKILL.md              # Skill 定义文档
├── README.md             # 使用说明（本文件）
├── .gitignore            # Git 忽略配置
├── .cookies.json         # Cookie 缓存（自动生成）
└── src/
    ├── index.js          # 主入口 & CLI
    ├── auth.js           # 登录认证模块
    └── api.js            # 腾讯文档 API 模块
```

## 注意事项

- Markdown 文档类型 (`doc_type`) 为 `14`
- 腾讯文档 URL 格式：`https://docs.qq.com/markdown/xxxxxxxx`
- 删除操作为移至回收站，可在腾讯文档回收站中恢复
- Cookie 保存在项目根目录的 `.cookies.json` 中，请勿泄露
- 需要 Node.js 16+ 和 Chromium（Puppeteer 自动下载）

## License

MIT
