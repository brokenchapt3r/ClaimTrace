# ClaimTrace Web

React 工作台负责查询输入、候选答案展示、原子声明检查、声明-证据二分图、传播轨迹、证据翻页和可信结果输出。

前端不直接访问 MySQL、Elasticsearch 或模型服务。开发模式下，Vite 将 `/api`、审计和运行日志请求代理到独立后端。

对话与嵌入模型可在工作台的“模型连接”面板中验证并保存。前端不会读取已保存的 API Key，只显示连接是否已配置。

```bash
cp .env.example .env.local
npm ci
npm run dev
```

默认页面端口为 `9222`，后端开发端口为 `9230`。

```bash
npm test
npm run type-check
npm run build
```

完整部署方式和环境需求见仓库根目录 [README](../README.md)。
