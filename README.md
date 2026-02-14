# Memory Manager v5 — PageIndex + Embedding + Agent 记忆管理扩展

**作者**: 金瓜瓜
**版本**: 5.0.0
**平台**: SillyTavern 1.13.0 第三方扩展

## 概述

基于 PageIndex + Embedding + MemGPT Agent 架构的自动记忆管理系统。通过**紧凑索引 + 语义向量预筛选 + 记忆代理推理 + 渐进式压缩 + 独立存档**解决长期对话中的记忆问题。

核心理念：**Embedding 缩小范围，Agent 判断选择，索引恒定，存档独立** — 像人类海马体一样联想记忆。

## 与 v4 的关键区别

| 特性 | v4 (PageIndex) | v5 (PageIndex+Embedding+Agent) |
|------|----------------|-------------------------------|
| 检索方式 | 2个工具，单轮工具调用 | 6个工具，支持两轮推理（搜索→选择） |
| 语义理解 | 无 | Embedding 向量余弦相似度预筛选 |
| 分类标签 | 无 | 8种语义分类（情感/关系/亲密/承诺/冲突/发现/转折/日常） |
| 存档系统 | 绑定 chatMetadata，切换聊天=失忆 | 独立存档，支持多槽位（主线/IF线），跨聊天加载 |
| 检索流程 | 副API → 关键词回退 | Embedding预筛选 → Agent推理 → 关键词回退（三层降级） |
| 代理能力 | 机械选3页 | 模拟人类记忆联想，按分类/天数/角色关系/关键词搜索后选择 |

## 架构

```
Layer 1: 故事索引 Story Index (始终在上下文, depth=9999, ~400-600 tokens)
  一、剧情时间线 (压缩格式: 旧事件合并为日期范围)
  二、已知角色态度 (主角色对{{user}}的态度摘要)
  三、NPC列表 (仅名字)
  四、物品索引 (仅名字 + 状态)
  → 模型的"目录"，知道发生过什么但不占太多空间

Layer 2+3: 统一检索流 (按需, 每次最多3页+2角色, depth=2)
  ┌─ Embedding 可用？
  │   YES → 余弦相似度 top-K → 候选页面列表（缩小范围）
  │   NO  → 全部页面目录
  ├─ 副API 可用？
  │   YES → 记忆代理（6个工具，两轮推理）→ 选择页面+角色
  │   NO  → 关键词匹配 fallback
  └─ 注入选中的页面+角色

渐进式压缩:
  → 详细页(L0, 100-300字) → 摘要页(L1, 30-50字) → 归档(L2, 融入时间线后删除)
  → 时间线超过20行自动合并旧条目
  → 总注入量始终有上限

独立存档:
  → 记忆独立于聊天记录，通过 /api/files 持久化
  → 支持多存档槽位（主线/IF线/分支线）
  → 切换聊天时自动提示加载同角色存档
```

## 文件结构

| 文件 | 说明 |
|------|------|
| `manifest.json` | 扩展元数据，含 `generate_interceptor` |
| `index.js` | 主逻辑（~3700行） |
| `settings.html` | 设置面板 UI（故事索引预览 + 故事页浏览器 + 存档管理 + Embedding设置） |
| `style.css` | 样式（压缩级别、语义分类标签、存档卡片、悬浮球） |
| `README.md` | 本文件 |
| `DEVLOG.md` | 开发日志 |

## 核心功能

### 1. 自动记忆提取（写入）
- 每 N 条消息自动触发（默认5条）
- 通过副API或主API后台调用
- LLM 分析新消息，输出 JSON：更新时间线 + 人物 + 物品 + 提取故事页
- **新增**: 故事页自动分配语义分类标签（emotional/relationship/intimate/promise/conflict/discovery/turning_point/daily）
- 时间线自动控制行数（旧事件合并为日期范围）
- 提取后自动运行压缩周期
- **新增**: 提取后自动保存到当前存档槽位
- **新增**: 提取后自动生成页面 Embedding 向量

### 2. 统一检索流（Embedding → Agent → Keywords）

`generate_interceptor` 在 prompt 组装前执行，三层降级检索：

**Step 1: Embedding 预筛选**（可选）
- 直接从浏览器调用中转站 `/v1/embeddings` 端点（无需修改 ST 核心）
- 将最近对话文本转为向量，与所有页面向量计算余弦相似度
- 返回 top-K 候选页面（默认10个），缩小代理搜索范围
- 向量存储在本地 memory data 中（256维 ≈ 1KB/页）

**Step 2: 记忆代理推理**（需副API）
- 代理收到候选页面目录（或全部目录），模拟人类记忆联想
- 6个增强工具（见下文），支持两轮推理
- 第一轮：搜索工具（按分类/天数/角色/关键词）→ 本地执行 → 返回结果
- 第二轮：根据搜索结果用 `recall_story_page` 选择具体页面
- 最多选择3页 + 2个角色档案

**Step 3: 关键词回退**（无副API时）
- 从最近消息提取关键词
- 匹配页面 keywords 数组
- 按匹配分数排序

### 3. 增强记忆代理（6个工具）

| 工具 | 说明 |
|------|------|
| `recall_story_page(page_id)` | 检索故事页详细内容（最终检索工具） |
| `recall_character(name)` | 检索NPC角色档案 |
| `search_pages_by_category(category)` | 按语义分类搜索（返回页面列表） |
| `recall_pages_by_day(day)` | 按天数搜索（返回当天所有事件） |
| `get_relationship_history(character_name)` | 获取与某角色相关的所有事件 |
| `search_by_keyword(keyword)` | 关键词搜索 |

代理检索策略：
- 当前话题涉及什么过去的事？→ `recall_story_page` 直接取
- 提到某个人？→ `get_relationship_history` 找相关事件
- 情绪相关的场景？→ `search_pages_by_category("emotional")`
- 某天发生了什么？→ `recall_pages_by_day("D5")`
- 模糊印象？→ `search_by_keyword` 搜索

### 4. 语义分类标签

每个故事页自动分配1-3个语义分类：

| 分类 | 中文 | 颜色 | 说明 |
|------|------|------|------|
| emotional | 情感 | 粉 #ec4899 | 情感事件 |
| relationship | 关系 | 黄 #f59e0b | 关系变化 |
| intimate | 亲密 | 红 #ef4444 | 亲密互动 |
| promise | 承诺 | 紫 #8b5cf6 | 承诺/约定 |
| conflict | 冲突 | 橙 #f97316 | 冲突/争执 |
| discovery | 发现 | 青 #06b6d4 | 发现/揭秘 |
| turning_point | 转折 | 绿 #22c55e | 重大转折 |
| daily | 日常 | 灰 #6b7280 | 日常片段 |

### 5. 独立存档系统

- **工作副本**: 仍在 `chatMetadata`（向后兼容）
- **持久存档**: 通过 `/api/files/upload` 保存 JSON 到 ST 文件目录
- **存档索引**: 在 `extension_settings` 中维护（轻量，仅路径+元数据）
- **多槽位**: 支持主线、IF线、分支线等多存档
- **跨聊天**: 切换聊天时，如果新聊天无记忆但同角色有存档，自动提示加载
- **自动保存**: 提取后自动保存到当前槽位（可关闭）

### 6. Embedding 向量检索

- 直接从浏览器调用中转站 `/v1/embeddings`（中转站默认支持 CORS）
- 默认复用副API地址和密钥，也可单独配置
- 本地存储向量（`data.embeddings`），纯 JS 余弦相似度计算
- 页面创建/压缩/删除时自动更新向量
- 支持手动"重建向量库"
- **无需修改 SillyTavern 核心代码**

### 7. 渐进式压缩
- **页面压缩**: 详细页(L0) → 摘要页(L1) → 归档删除(L2)
  - L0→L1: 100-300字压缩为30-50字，保留核心事实
  - L1→L2: 信息已在时间线中，删除页面释放空间
- **时间线压缩**: 超过20行时自动合并旧条目为日期范围
- 可手动触发强制压缩

### 8. 副API支持
- 独立的 OpenAI 兼容 API 端点（支持 one-api / new-api 等中转站）
- 通过 SillyTavern 服务端代理避免 CORS
- 用于：记忆提取、代理检索（工具调用）、页面压缩
- 未配置时回退到关键词匹配

### 9. 批量初始化
- 一键从已有聊天记录 + 世界书 + 角色卡构建完整记忆库
- 世界书和角色卡作为独立的第一批处理（Batch 0）
- 聊天消息分批处理（每批20条）
- 初始化完成后自动生成 Embedding 向量

### 10. 数据兼容
- 自动迁移链: v1→v2→v3→v4
- v1: storyBible + memories → v2: timeline + pages
- v3: 无 categories/embeddings → v4: 添加 categories + embeddings
- 导入也支持所有旧版本格式

## 数据存储

工作数据存储在 `chatMetadata.memoryManager`，持久存档通过 `/api/files` 保存：

```javascript
{
  version: 4,
  timeline: "D1-D3: 概括...\nD4: ...\nD5: ...",
  knownCharacterAttitudes: [{ name, attitude }],
  characters: [{ name, appearance, personality, relationship, currentState, attitude }],
  items: [{ name, status, significance }],
  pages: [{
    id, day, title, content,
    keywords[], characters[],
    categories[],         // v5新增: 语义分类标签
    significance, compressionLevel,
    sourceMessages[], createdAt, compressedAt
  }],
  embeddings: {},         // v5新增: { [pageId]: number[] } 向量缓存
  processing: { lastExtractedMessageId, extractionInProgress },
  messageRecalls: { [messageId]: [pageId, ...] }
}
```

## 设置项

| 设置 | 默认值 | 说明 |
|------|--------|------|
| enabled | true | 启用/禁用 |
| debug | false | 调试日志 |
| extractionInterval | 5 | 每N条消息触发提取 |
| extractionMaxTokens | 4096 | 提取API最大响应token |
| knownCharacters | '' | 已知角色（逗号分隔，不生成详细档案） |
| indexDepth | 9999 | 故事索引注入深度 |
| recallDepth | 2 | 故事页/档案注入深度 |
| maxPages | 3 | 最大检索故事页数 |
| autoCompress | true | 自动渐进式压缩 |
| showRecallBadges | true | 显示召回UI |
| autoHide | false | 自动隐藏已处理消息 |
| keepRecentMessages | 10 | 保留最近N条可见 |
| **useSecondaryApi** | false | 使用副API |
| secondaryApiUrl | '' | 副API地址 |
| secondaryApiKey | '' | 副API密钥 |
| secondaryApiModel | '' | 副API模型 |
| secondaryApiTemperature | 0.3 | 副API温度 |
| **autoSaveSlot** | true | 提取后自动保存到当前存档 |
| **useEmbedding** | false | 启用 Embedding 语义检索 |
| embeddingModel | 'text-embedding-3-large' | Embedding 模型 |
| embeddingDimensions | 256 | 向量维度 |
| embeddingTopK | 10 | 预筛选 top-K 数量 |
| embeddingApiUrl | '' | Embedding API地址（留空复用副API） |
| embeddingApiKey | '' | Embedding API密钥（留空复用副API） |

## Slash 命令

| 命令 | 说明 |
|------|------|
| `/mm-extract` | 强制执行记忆提取 |
| `/mm-recall` | 显示当前召回的故事页 |
| `/mm-index` | 显示当前故事索引 |
| `/mm-pages` | 列出所有故事页（含压缩级别和分类标签） |
| `/mm-compress` | 强制执行压缩周期 |
| `/mm-reset` | 重置当前聊天的记忆数据 |

## 检索流程图

```
用户发送消息
    │
    ▼
generate_interceptor 触发 retrieveMemories()
    │
    ├── Layer 1: Story Index 始终注入 (depth=9999)
    │     时间线 + 已知角色态度 + NPC列表 + 物品
    │
    ├── Layer 2+3: 统一检索流
    │     │
    │     ├─ [1] Embedding 预筛选 (如果启用)
    │     │     最近对话 → 向量化 → 余弦相似度 → top-K 候选
    │     │
    │     ├─ [2] Agent 推理 (如果副API可用)
    │     │     候选页面(或全部) → 6个工具 → 两轮推理 → 选页面+角色
    │     │     Round 1: 搜索工具 → 本地执行 → 返回结果
    │     │     Round 2: recall_story_page 选择具体页面
    │     │
    │     └─ [3] 关键词回退 (以上都未检索到时)
    │           提取关键词 → 匹配 keywords 数组 → 排序
    │
    └── 注入选中内容 (depth=2)
          故事页: 叙事还原风格 "回忆起了……"
          角色档案: 外貌/性格/态度/当前状态
```
