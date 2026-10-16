# FlashDesk English

FlashDesk 是一个本地优先的英语学习应用。Node 版由零依赖的 `node:http` 服务提供页面与 JSON API；PWA 版从 `docs/` 发布，卡片数据保存在设备本地。长文章、AI 草稿和音频缓存与卡片学习数据分开保存。

## 主要功能

- **复习**：卡片翻面后可选择“再来一次”“记住了”“很熟”。每一张实体卡独立进入队列、独立评分；即使两张卡的正反面互换，也不会折叠或静默同步评分。
- **调度**：“记住了”沿 `1 → 3 → 7 → 14 → 30 → 60 → 120 → 240 → 365` 天阶梯前进；“再来一次”重置当前连续记忆并累计历史遗忘；“很熟”使用同一调度体系跳过部分早期间隔。`streak >= 3` 才显示为已掌握。
- **单词库与检测**：支持搜索、学习状态筛选、批量导入、详情编辑与自适应检测。检测不会修改复习进度。
- **阅读**：Article 数据独立保存，支持进度、逐段翻译、点词、朗读和用户主动标记的生词。界面的“阅读自报熟悉度”只表示阅读中未标记为生词的 token 比例，不代表长期掌握。
- **AI 学习**：Provider 由本地设置选择，当前 Worker 支持智谱与 Gemini；查词、长句、短文和翻译使用服务端配置的模型。生成成功后先保存为独立本地草稿，用户明确确认后才进入卡片或 Reading。
- **发音**：普通/慢速发音走现有高质量 TTS 与离线音频缓存，失败时可回退系统语音；AI 发音是独立 `/pronounce` 通道，当前 Worker 使用 Cloudflare Workers AI Aura-1，并支持固定 speaker。
- **备份恢复**：完整备份覆盖学习、阅读、AI history 与 usage stats。恢复采用 recovery snapshot 与 journal；异常中断时会要求用户先处理恢复状态。备份与校验降低风险，但不应替代额外的离线备份。

## 数据与并发

- Node 学习数据默认写入 `flashdesk-data.json`，Article/Reading 写入 `flashdesk-articles.json`。
- PWA 学习数据保存在 localStorage；文章与 AI 草稿保存在 `flashdesk-content` IndexedDB；发音缓存保存在独立 IndexedDB。
- PWA 多标签写入使用版本冲突检测。旧标签不会无提示覆盖较新的完整学习快照；发生冲突时应刷新后重试。
- 新 Service Worker 会及时安装、接管并清理旧 cache，但页面不会在 `controllerchange` 时强制刷新。页面显示“新版本已准备好”，由用户点击更新；活跃复习、未保存 AI 内容或表单输入会先确认，未完成恢复会阻止刷新。

## 本地运行

需要 Node.js 18 或更新版本，无需安装 npm 依赖：

```sh
node server.js
```

默认仅监听 `127.0.0.1:5902`。如确需局域网调试，可显式设置：

```powershell
$env:FLASHDESK_HOST = '0.0.0.0'
node server.js
```

监听到局域网不等于获得认证保护；不要在不可信网络上暴露本地数据服务。

## PWA 构建与更新

`docs/` 是构建产物，不要手工编辑：

```sh
node build.js
```

构建会复制 `public/`，替换 PWA 存储适配器，加入默认 137 个 Words，并用内容哈希生成 Service Worker cache 名和页面版本号。HTML 导航采用 network-first；静态资源来自当前版本 cache。更新只清理旧 Cache Storage，不清除 localStorage、IndexedDB、学习数据或设备设置。

## 安全边界

- API key 与上游 Secret 只放在 Worker/Gateway 的环境变量或 secret 中，不写入前端与仓库。
- CORS 不是认证；AI/TTS 接口仍需 Bearer token、限频和脱敏日志。
- AI 结果是学习草稿，可能不准确，保存前应人工确认。
- `backup/`、正式数据文件、`.env`、`.dev.vars`、Wrangler 本地状态和 `node_modules` 不应提交。

## 测试

```sh
node --test
node build.js
git diff --check
```
