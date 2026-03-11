# standalone_claw

将 [openclaw](https://github.com/openclaw/openclaw) 及所需的 Node.js 运行环境打包成一个可直接双击运行的可执行文件。无需用户预先安装 Node.js 或 npm。

> Package [openclaw](https://github.com/openclaw/openclaw) together with the Node.js runtime into a single double-clickable executable. No Node.js installation required for end users.

---

## 特性 / Features

- **零依赖运行**：可执行文件内嵌 Node.js 运行时，用户无需安装 Node.js。
- **配置文件就近存储**：`openclaw.json` 及所有状态文件存放在可执行文件所在目录，而非用户主目录（`~/.openclaw`）。
- **双击即用**：Windows / Linux / macOS 均可直接运行。
- **跨平台构建**：一条命令即可生成 Windows、Linux、macOS（x64 及 arm64）四个平台的可执行文件。

---

## 构建 / Build

### 前置要求

- Node.js ≥ 22.12.0
- npm ≥ 10

### 安装依赖

```bash
npm install
```

### 构建所有平台

```bash
npm run build
```

生成的可执行文件位于 `dist/` 目录：

| 文件 | 平台 |
|------|------|
| `openclaw-win.exe` | Windows x64 |
| `openclaw-linux` | Linux x64 |
| `openclaw-macos` | macOS x64 (Intel) |
| `openclaw-macos-arm64` | macOS arm64 (Apple Silicon) |

### 仅构建特定平台

```bash
npm run build:win      # Windows
npm run build:linux    # Linux
npm run build:macos    # macOS
```

---

## 使用 / Usage

1. 将对应平台的可执行文件复制到任意目录。
2. **双击** 或在终端中直接运行（Linux / macOS 需先赋予执行权限）：

   ```bash
   # Linux / macOS
   chmod +x openclaw-linux   # 或 openclaw-macos / openclaw-macos-arm64
   ./openclaw-linux

   # Windows — 直接双击 openclaw-win.exe 即可
   ```

3. 首次运行时，openclaw 会在 **可执行文件所在目录** 自动创建 `openclaw.json` 配置文件并引导完成初始配置。

> **提示**：若想覆盖配置路径，可在运行前设置环境变量：
> ```bash
> OPENCLAW_CONFIG_PATH=/path/to/openclaw.json ./openclaw-linux
> OPENCLAW_STATE_DIR=/path/to/state/dir ./openclaw-linux
> ```

---

## 工作原理 / How it works

`src/main.cjs` 是打包入口，它在启动 openclaw 之前完成两件事：

1. **定位可执行文件目录** — 通过 `process.pkg`（由 `@yao-pkg/pkg` 注入）与 `process.execPath` 判断当前运行目录。
2. **重定向配置路径** — 将 `OPENCLAW_STATE_DIR` 和 `OPENCLAW_CONFIG_PATH` 设置为可执行文件所在目录（若用户未手动设置这两个环境变量）。

之后通过动态 `import()` 加载 openclaw 的 ESM 入口（`openclaw.mjs`）。

打包工具 [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) 将以下内容嵌入到单个可执行文件中：
- Node.js 22 运行时
- `src/main.cjs` 启动器
- `node_modules/openclaw/` 下的全部文件（作为虚拟文件系统资产）

> **注意**：openclaw 依赖若干原生 Node.js 模块（`.node` 文件，例如 `node-pty`、`koffi`、`@napi-rs/canvas` 等）。`pkg` 会在首次运行时将这些文件解压到系统临时目录并自动加载，无需用户手动处理。

---

## 项目结构 / Project structure

```
standalone_claw/
├── src/
│   └── main.cjs          # 打包入口 / pkg entry point
├── scripts/
│   └── build.mjs         # 构建脚本 / build script
├── package.json
├── .gitignore
└── README.md
```
