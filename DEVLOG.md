# Memory Manager — 开发日志

## Session 1-3: v3 基础框架 (Story Bible 架构)

详见 git 历史。v3 实现了：
- 两层记忆架构（故事圣经 + 记忆条目）
- 自动提取（每N条消息）
- 副API支持（通过服务端代理避免CORS）
- 批量初始化（世界书+角色卡+聊天记录）
- 自动隐藏已处理消息
- JSON 解析容错（换行符、未转义引号、尾部逗号）

v3 的问题：
- 故事圣经全量注入，随剧情线性增长，token无上限
- 关键词匹配检索精度不够
- 架构本质上和手动 Plot Summary 没有根本区别，只是自动化了

---

## Session 4: v4 重构 — PageIndex 架构

### 4.1 架构分析

用户指出 v3 和手动方法差距不大，提供了参考资料：
- **PageIndex 知识树**: 不做分块向量化，而是构建层级目录→LLM导航查找
- **Claude Code 的 Compressor (WU2/AU2)**: 智能压缩上下文，分段处理
- **Agentic Memory (Mem0)**: 模型主动管理笔记，评估临时/长期/需更新
- **核心洞察**: "比单独靠模型这一点上下文和压缩来做记忆要强多了"

### 4.2 架构重设计

**核心变化: 从"注入一切"到"索引+按需检索+压缩"**

```
v3: Story Bible (全量注入, 无上限) + Memories (关键词匹配)
    → token 随剧情线性增长

v4: Story Index (紧凑, 仅时间线+物品, ~400-600 tokens) + Pages (工具调用检索) + Compression
    → token 有上限, 旧内容自动压缩
```

三层结构:
- **Layer 1 - Story Index**: 始终注入，紧凑格式（仅时间线+物品，不含角色）
  - 时间线自动压缩：旧事件合并为日期范围 "D1-D3: 概括"
  - 角色完全从索引中移除，改为按需工具调用检索
  - 总量控制在 ~400-600 tokens
- **Layer 2 - Story Pages**: 按需检索，每次最多3页
  - 工具调用：副API通过 `recall_story_page` function calling 选择页面
  - 关键词匹配作为无副API时的备选
- **Layer 3 - Character Dossiers**: 按需注入角色详细档案
  - 工具调用：副API通过 `recall_character` function calling 选择角色

### 4.3 渐进式压缩引擎

```
Fresh (L0, 100-300字)  ──超过15页──>  Compressed (L1, 30-50字)  ──超过20页──>  Archived (L2, 删除)
                                          ↑ LLM压缩                              ↑ 信息已在时间线中

时间线超过20行  ──>  LLM合并旧条目为日期范围
```

### 4.4 工具调用检索 (Tool Calling)

替代 v3 的简单关键词匹配，也替代 v4 初版的文本补全 LLM 导航：
1. 定义两个 OpenAI function tools: `recall_story_page(page_id)` 和 `recall_character(name)`
2. 将故事索引 + 页面目录 + 角色列表 + 最近对话 发给副API，附带 `tools` + `tool_choice: 'auto'`
3. 副API 通过 tool_calls 返回要检索的页面ID和角色名
4. 解析 tool_calls，检索对应内容，注入 depth=2
5. 无副API时回退到关键词匹配

### 4.5 数据迁移

- v1 (storyBible.timeline + memories[]) → v2 (timeline + pages[])
- 自动检测数据版本，首次加载时迁移
- 导入也支持 v1 格式自动转换

### 4.6 文件变更

| 文件 | 变更 |
|------|------|
| `index.js` | 完全重写 (~2000行)，新架构 |
| `settings.html` | 更新UI，新增压缩设置、页面统计 |
| `style.css` | 新增压缩级别视觉区分 (绿色=详细, 黄色=摘要) |
| `manifest.json` | 版本号 3.0.0 → 4.0.0 |
| `README.md` | 重写，反映新架构 |

### 4.7 新增 Slash 命令

| 命令 | 说明 |
|------|------|
| `/mm-pages` | 列出所有故事页（替代 `/mm-memories`） |
| `/mm-compress` | 强制执行压缩周期 |

---

## Session 5: 工具调用检索 + 索引精简 + 初始化改进

### 5.1 用户反馈 (问题.md)

用户指出4个问题：
1. 故事圣经/时间线思路是好的，大的剧情梗概必要
2. **副API检索不应该用文本补全** — "明明可以最直接工具调用来检索"
3. NPC也应该用召回方式，不必放在索引中
4. 叙事连贯性靠大纲维持

### 5.2 工具调用检索

新增 `callSecondaryApiWithTools()` — 通过 SillyTavern 服务端代理发送带 `tools` 参数的请求：
- 定义 `recall_story_page(page_id)`: 枚举所有可用页面ID
- 定义 `recall_character(name)`: 枚举所有角色名
- 副API 返回 `tool_calls`，解析后检索对应内容
- 比文本补全更直接、更结构化、更不容易出错

### 5.3 故事索引精简

`formatStoryIndex()` 只保留：
- 一、剧情时间线
- 二、物品

角色完全移除，改为通过 `recall_character` 按需检索。索引从 ~800 tokens 降至 ~400-600 tokens。

### 5.4 初始化改进

`performBatchInitialization()` 重写：
- 世界书 + 角色卡作为独立的 Batch 0 处理（不混入第一批聊天消息）
- 聊天消息从 Batch 1 开始，按20条分批
- 进度UI显示当前批次类型（"世界书与角色卡" / "聊天消息 1-20"）

---

## 当前状态

### 已完成
- [x] PageIndex 三层架构（索引 + 故事页 + 角色档案）
- [x] 工具调用检索（副API通过function calling选页面/角色）
- [x] 渐进式压缩（L0→L1→L2 + 时间线压缩）
- [x] 紧凑故事索引（仅时间线+物品，角色按需检索）
- [x] 按需角色档案注入（通过 recall_character 工具调用）
- [x] v1→v2 数据自动迁移
- [x] 副API支持（文本补全 + 工具调用两种模式）
- [x] 批量初始化（世界书单独批次 + 聊天分批）
- [x] 自动隐藏已处理消息
- [x] JSON 解析容错
- [x] 设置面板 + 故事页浏览器
- [x] 消息气泡召回显示
- [x] Slash 命令
- [x] 导出/导入记忆数据

### 待测试/观察
- 工具调用检索是否被 SillyTavern 服务端代理正确透传
- 渐进式压缩的实际效果（压缩质量、信息保留度）
- 工具调用检索的准确度（tool_calls 解析、枚举约束）
- 时间线压缩后的信息密度

### 关键技术决策记录
| 决策 | 选择 | 原因 |
|------|------|------|
| 架构 | PageIndex (索引+按需检索+压缩) | 解决v3 token无限增长问题 |
| 检索 | 工具调用 (function calling) + 关键词备选 | 比文本补全更直接可靠，副API直接选页面/角色 |
| 索引内容 | 仅时间线+物品，角色按需 | 角色信息不常用时不占索引空间 |
| 压缩 | 三级渐进式 (L0→L1→L2) | 平衡信息保留和空间释放 |
| 索引格式 | 纯文本紧凑格式 | 比JSON省token，LLM更易读 |
| 数据存储 | chatMetadata (不变) | 随聊天文件持久化，切换自动隔离 |
| 副API路由 | SillyTavern 服务端代理 (不变) | 避免CORS |
| 数据版本 | v2, 自动迁移v1 | 向后兼容 |
