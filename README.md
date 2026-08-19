# ClaimTrace

ClaimTrace 是一套可独立部署的知识库问答系统。它从知识库检索证据，调用大模型生成答案并拆分声明，通过声明-证据图完成关系判断、约束传播和引用选择，最终输出带证据与解释路径的结果。

仓库已经包含 React 前端、Node.js API、MySQL、Elasticsearch、文档解析、模型适配和 Docker Compose，不依赖其他项目源码。

## 适用场景

- 对内部规章、技术资料、论文和产品文档进行可追溯问答
- 检查模型答案中的具体事实是否得到知识库证据支持
- 展示支持、冲突、证据不足和无权限状态
- 回放约束传播过程并导出签名审计记录

## 运行要求

| 项目 | 最低要求 | 建议配置 |
| --- | --- | --- |
| 操作系统 | 64 位 Linux | Ubuntu 22.04 / Debian 12 |
| Docker Engine | 24.0+ | 最新稳定版 |
| Docker Compose | 2.24+ | 最新稳定版 |
| CPU | 4 核 | 8 核以上 |
| 内存 | 8 GB | 16 GB |
| 磁盘 | 15 GB | 30 GB SSD |

只使用 Docker 时，宿主机不需要安装 Node.js。源码开发需要 Node.js 20 和 npm 10+。

## 模型接口要求

系统需要两个 OpenAI 兼容 API：

| 用途 | 必需接口 | 推荐模型 |
| --- | --- | --- |
| 对话与关系判断 | `/v1/models`、`/v1/chat/completions` | `qwen3:8b`、`qwen-flash` |
| 文档与查询向量化 | `/v1/models`、`/v1/embeddings` | `bge-m3` |

默认嵌入维度为 1024。模型服务输出维度不同时，必须同步修改 `EMBEDDING_DIMENSIONS`，并使用新的 Elasticsearch 索引重新导入文档。

模型服务运行在宿主机时，容器内应使用 `host.docker.internal`，不能使用 `127.0.0.1`。例如：

```text
http://host.docker.internal:8001/v1
```

## 快速启动

```bash
git clone https://github.com/brokenchapt3r/ClaimTrace.git
cd ClaimTrace
cp .env.example .env
```

编辑 `.env`，至少修改 MySQL 密码和两个模型连接：

```dotenv
MYSQL_PASSWORD=replace-with-a-long-random-password
MYSQL_ROOT_PASSWORD=replace-with-another-long-random-password

CHAT_MODEL=qwen3:8b
CHAT_BASE_URL=http://host.docker.internal:8001/v1
CHAT_API_KEY=local-api-key

EMBEDDING_MODEL=bge-m3
EMBEDDING_BASE_URL=http://host.docker.internal:6380/v1
EMBEDDING_API_KEY=local-api-key
EMBEDDING_DIMENSIONS=1024
```

启动全部服务：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

所有容器健康后访问：

```text
http://<服务器IP>:9222/
```

检查服务状态：

```bash
curl http://127.0.0.1:9222/healthz
```

正常响应示例：

```json
{"status":"ok","mysql":"ok","elasticsearch":"ok","models":["qwen3:8b","bge-m3"]}
```

## 首次配置

1. 打开工作台左侧的“模型连接”。
2. 填写对话模型的实例名称、模型名称、Base URL 和 API Key。
3. 点击“验证”，确认 `/models` 和对话请求可用，然后保存。
4. 使用相同步骤配置嵌入模型。
5. 保存后的配置优先于 `.env`，更换对话模型不需要重新构建镜像。

API Key 由服务端使用 AES-256-GCM 加密后保存。前端读取配置时只会收到“已配置”状态，不会取回明文密钥。

## 导入知识库

支持以下文件：

```text
.txt  .md  .csv  .json  .html  .docx  .pdf
```

导入步骤：

1. 点击左侧“导入文档”。
2. 选择目标知识库和文件。
3. 按需填写版本、生效日期、条款标识和权限范围。
4. 等待页面显示文档状态为可用，并确认分块数量大于 0。

建议优先使用包含可复制文本的 PDF。扫描件需要先进行 OCR；图片型 PDF 没有文本层时无法产生有效证据分块。

## 执行问答

1. 输入能够由知识库回答的具体问题。
2. 选择普通或高敏判断门限。
3. 点击“查询并核验”。
4. 查看检索分数、候选答案和原子声明。
5. 等待声明-证据关系批次完成。
6. 查看二分图、状态传播、证据理由和最终答案。
7. 点击证据编号进行分页预览，或下载审计记录。

关系判断会根据声明和证据数量拆分为多个模型请求，页面会显示 `已完成批次/总批次`。如果模型漏掉未知关系，系统会自动缩小请求范围并调用模型补算，不会使用预设关系。

## 常用运维命令

查看状态：

```bash
docker compose ps
curl http://127.0.0.1:9222/healthz
```

查看应用与模型输出日志：

```bash
docker compose logs -f --tail=200 app
```

重启应用，不影响数据库和索引：

```bash
docker compose restart app
```

更新代码并重建：

```bash
git pull --ff-only
docker compose up -d --build
```

停止服务并保留数据：

```bash
docker compose down
```

不要随意执行 `docker compose down -v`，该命令会删除知识库、索引、审计记录和加密密钥。

## 数据位置

Docker Compose 使用三个命名卷：

| 数据卷 | 内容 |
| --- | --- |
| `claimtrace_mysql` | 知识库、文档元数据、模型连接和审计记录 |
| `claimtrace_es` | BM25 与向量检索索引 |
| `claimtrace_data` | 审计签名私钥和模型凭据加密密钥 |

本地 `.env`、模型密钥、知识库数据、索引、`node_modules` 和构建产物均已排除在 Git 提交之外。

## 常见问题

### 页面显示 `fetch failed`

```bash
docker compose ps
docker compose logs --tail=200 app
curl http://127.0.0.1:9222/healthz
```

确认应用容器健康，并检查浏览器访问的是服务器 IP，而不是 SSH 客户端自己的 `localhost`。

### 模型连接失败

确认 Base URL 包含 `/v1`，容器能够访问模型地址，并且 `/v1/models` 返回了所填模型名称。本地模型服务的 API Key 可以使用占位值，但字段不能被服务端拒绝。

### Embedding HTTP 500 或 NaN

系统会规范化文档文本，并对失败批次自动拆分。错误持续出现时，应检查嵌入服务日志、模型显存、输入长度限制，以及返回向量是否包含 `NaN` 或 `Infinity`。

### Embedding dimension mismatch

`EMBEDDING_DIMENSIONS` 必须与模型实际返回维度完全一致。修改维度后应更换 `ELASTICSEARCH_INDEX` 名称并重新导入文档，不能把不同维度写入已有索引。

### 关系判断耗时较长

耗时取决于声明数、证据数和模型响应速度。系统最多并发执行三个批次，并对缺失组合进行真实模型补算。可通过应用日志中的 `stage=relations:x/y` 查看进度。

## 主要配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLAIMTRACE_PORT` | `9222` | Web 与 API 端口 |
| `CLAIMTRACE_LOG_LEVEL` | `info` | 结构化日志级别 |
| `CHAT_MODEL` | `qwen3:8b` | 初始对话模型 |
| `CHAT_BASE_URL` | 无 | 初始对话 API 地址 |
| `CHAT_TIMEOUT_MS` | `180000` | 对话请求超时 |
| `EMBEDDING_MODEL` | `bge-m3` | 初始嵌入模型 |
| `EMBEDDING_BASE_URL` | 无 | 初始嵌入 API 地址 |
| `EMBEDDING_DIMENSIONS` | `1024` | 向量维度 |
| `EMBEDDING_TIMEOUT_MS` | `120000` | 嵌入请求超时 |
| `RETRIEVAL_CANDIDATE_COUNT` | `30` | 混合召回候选数 |
| `RETRIEVAL_FINAL_COUNT` | `12` | 进入验证流程的证据数 |
| `ELASTICSEARCH_INDEX` | `claimtrace_chunks_v1` | 证据索引名称 |

完整配置模板见 [.env.example](./.env.example)。

## 源码开发

```bash
docker compose up -d mysql elasticsearch

cd server
npm ci
CLAIMTRACE_PORT=9230 npm run dev

cd ../web
cp .env.example .env.local
npm ci
npm run dev
```

质量检查：

```bash
cd server
npm test
npm run type-check
npm run build

cd ../web
npm test
npm run type-check
npm run build
```

GitHub Actions 会对前后端执行安装、测试、类型检查和生产构建。

## 目录说明

| 路径 | 作用 |
| --- | --- |
| `server/src/` | API、数据库、文档导入、检索、模型代理和审计 |
| `web/src/adapters/` | 检索与结构化模型适配 |
| `web/src/core/` | 图构建、约束传播、优化和答案重写 |
| `web/src/pages/home/` | 工作台页面和业务组件 |
| `compose.yaml` | MySQL、Elasticsearch 和应用编排 |
| `code-screenshots/` | 与源码同步的处理流程代码图 |

## 安全提示

- 端口 9222 暴露到不可信网络前，应配置身份认证和 HTTPS 反向代理。
- MySQL 和 Elasticsearch 默认只在 Compose 内部网络可见。
- 不要提交 `.env`、日志、数据库备份、索引或任何模型密钥。
- 怀疑凭据泄露时，应立即轮换模型 API Key 和数据库密码。

## License

MIT License，详见 [LICENSE](./LICENSE)。
