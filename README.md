# Memory Manager v4 — PageIndex 记忆管理扩展

**作者**: 金瓜瓜
**版本**: 4.0.0
**平台**: SillyTavern 1.13.0 第三方扩展

## 概述

基于 PageIndex 架构的自动记忆管理系统。通过**紧凑索引 + 按需检索 + 渐进式压缩**解决长期对话中的记忆问题。

核心理念：**索引恒定，内容按需，旧页自动压缩** — 无论故事多长，注入的token量都有上限。

## 与 v3 的关键区别

| 特性 | v3 (Story Bible) | v4 (PageIndex) |
|------|-------------------|-----------------|
| 索引/目录 | 全量故事圣经，无限增长 | 紧凑故事索引（仅时间线+物品），~400-600 tokens |
| 详细内容 | 全部注入 | 按需检索，每次最多3页 |
| 检索方式 | 关键词匹配 | 工具调用检索（副API通过function calling选页面/角色） |
| 旧记忆 | 永久保留，不压缩 | 渐进压缩：详细→摘要→归档 |
| token消耗 | 随剧情线性增长 | 有上限，旧事件自动压缩 |
| 角色信息 | 始终全量注入 | 仅被提及时按需注入档案 |

## 架构

```
保留: Tidal Memory (主AI每回合末尾的局部记忆)
替代: Plot Summary → 以下三层自动化系统

Layer 1: 故事索引 Story Index (始终在上下文, depth=9999, ~400-600 tokens)
  一、剧情时间线 (压缩格式: 旧事件合并为日期范围)
  二、物品索引 (仅名字 + 状态)
  → 角色不在索引中，完全按需通过工具调用检索
  → 模型的"目录"，知道发生过什么但不占太多空间

Layer 2: 故事页 Story Pages (按需检索, 每次最多3页, depth=2)
  → 工具调用检索: 副API通过 recall_story_page 函数选择页面
  → 关键词匹配作为无副API时的备选
  → 叙事还原风格注入 "回忆起了……"
  → 是目录上的"放大镜"

Layer 3: 角色档案 Character Dossiers (按需检索, 最多2个, depth=2)
  → 工具调用检索: 副API通过 recall_character 函数选择角色
  → 当对话涉及特定角色时，注入其详细档案
  → 外貌/性格/关系变化轨迹/当前状态

渐进式压缩:
  → 详细页(L0, 100-300字) → 摘要页(L1, 30-50字) → 归档(L2, 融入时间线后删除)
  → 时间线超过20行自动合并旧条目
  → 总注入量始终有上限
```

## 文件结构

| 文件 | 说明 |
|------|------|
| `manifest.json` | 扩展元数据，含 `generate_interceptor` |
| `index.js` | 主逻辑（~2000行） |
| `settings.html` | 设置面板 UI（含故事索引预览 + 故事页浏览器） |
| `style.css` | 样式（含压缩级别视觉区分） |
| `README.md` | 本文件 |
| `DEVLOG.md` | 开发日志 |

## 核心功能

### 1. 自动记忆提取（写入）
- 每 N 条消息自动触发（默认5条）
- 通过副API或主API后台调用
- LLM 分析新消息，输出 JSON：更新时间线 + 人物 + 物品 + 提取故事页
- 时间线自动控制行数（旧事件合并为日期范围）
- 提取后自动运行压缩周期

### 2. 工具调用检索与注入（读取）
- `generate_interceptor` 在 prompt 组装前执行
- **故事索引**始终注入（depth=9999，仅时间线+物品，~400-600 tokens）
- **故事页 + 角色档案**按需检索：
  - 有副API时：通过 OpenAI function calling（`recall_story_page` / `recall_character` 工具）
  - 无副API时：关键词匹配作为备选
- 最多3页 + 2个角色档案注入（depth=2）

### 3. 渐进式压缩
- **页面压缩**: 详细页(L0) → 摘要页(L1) → 归档删除(L2)
  - L0→L1: 100-300字压缩为30-50字，保留核心事实
  - L1→L2: 信息已在时间线中，删除页面释放空间
- **时间线压缩**: 超过20行时自动合并旧条目为日期范围
- 可手动触发强制压缩

### 4. 副API支持
- 独立的 OpenAI 兼容 API 端点
- 通过 SillyTavern 服务端代理避免 CORS
- 用于：记忆提取（文本补全）、检索（工具调用 function calling）、页面压缩（文本补全）
- 检索时使用 `tools` + `tool_choice: 'auto'`，定义 `recall_story_page` 和 `recall_character` 两个工具
- 未配置时回退到关键词匹配

### 5. 批量初始化
- 一键从已有聊天记录 + 世界书 + 角色卡构建完整记忆库
- 世界书和角色卡作为独立的第一批处理（Batch 0），确保设定信息优先提取
- 聊天消息分批处理（每批20条），按时间顺序积累记忆

### 6. 数据兼容
- 自动迁移 v3 (v1) 数据到 v4 (v2) 格式
- memories → pages, storyBible → timeline/characters/items

## 数据存储

所有数据存储在 `chatMetadata.memoryManager`，随聊天文件自动持久化：

```javascript
{
  version: 2,
  timeline: "D1-D3: 概括...\nD4: ...\nD5: ...",
  characters: [{ name, appearance, personality, relationship, currentState }],
  items: [{ name, status, significance }],
  pages: [{
    id, day, title, content,
    keywords[], characters[],
    significance, compressionLevel,  // 0=详细, 1=摘要, 2=归档
    sourceMessages[], createdAt, compressedAt
  }],
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
| indexDepth | 9999 | 故事索引注入深度 |
| recallDepth | 2 | 故事页/档案注入深度 |
| maxPages | 3 | 最大检索故事页数 |
| autoCompress | true | 自动渐进式压缩 |
| compressAfterPages | 15 | L0页超过此数时压缩最旧的 |
| archiveAfterPages | 20 | L1页超过此数时归档最旧的 |
| maxTimelineEntries | 20 | 时间线超过此行数时压缩 |
| showRecallBadges | true | 显示召回UI |
| autoHide | false | 自动隐藏已处理消息 |
| keepRecentMessages | 10 | 保留最近N条可见 |
| useSecondaryApi | false | 使用副API |
| secondaryApiUrl | '' | 副API地址 |
| secondaryApiKey | '' | 副API密钥 |
| secondaryApiModel | '' | 副API模型 |
| secondaryApiTemperature | 0.3 | 副API温度 |

## Slash 命令

| 命令 | 说明 |
|------|------|
| `/mm-extract` | 强制执行记忆提取 |
| `/mm-recall` | 显示当前召回的故事页 |
| `/mm-index` | 显示当前故事索引 |
| `/mm-pages` | 列出所有故事页（含压缩级别） |
| `/mm-compress` | 强制执行压缩周期 |
| `/mm-reset` | 重置当前聊天的记忆数据 |
