/**
 * Memory Manager v4.0 — PageIndex Architecture
 *
 * Three-layer memory system inspired by pageIndex + Claude Code compressor:
 *   Layer 1: Story Index (always injected, compact ~800 tokens, bounded)
 *   Layer 2: Story Pages (retrieved on demand, detailed event descriptions)
 *   Layer 3: Character Dossiers (retrieved on demand, detailed profiles)
 *
 * Key innovations over v3:
 *   - Story Index stays bounded via progressive compression
 *   - LLM-navigated retrieval (secondary API reads index → selects pages)
 *   - Old events auto-compress: Fresh(L0) → Compressed(L1) → Archived(L2)
 *   - Characters stored as dossiers, only injected when relevant
 */

import {
    eventSource,
    event_types,
    generateQuietPrompt,
    getRequestHeaders,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    saveSettingsDebounced,
    substituteParams,
    is_send_press,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
    saveMetadataDebounced,
} from '../../../extensions.js';

import {
    hideChatMessageRange,
} from '../../../chats.js';

import {
    getSortedEntries,
} from '../../../world-info.js';

// ============================================================
//  Constants
// ============================================================

const MODULE_NAME = 'memory_manager';
const LOG_PREFIX = '[MemMgr]';
const PROMPT_KEY_INDEX = 'mm_story_index';
const PROMPT_KEY_PAGES = 'mm_recalled_pages';
const DATA_VERSION = 2;

// Compression level constants
const COMPRESS_FRESH = 0;      // Full detail, 100-300 chars
const COMPRESS_SUMMARY = 1;    // Compressed, 30-80 chars
const COMPRESS_ARCHIVED = 2;   // Merged into timeline, page deleted

// Lottie mood system
const LOTTIE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie_light.min.js';
const MOOD_FILES = {
    idle: 'friendly-robot-animation_14079420.json',
    thinking: 'wink-robot-animation_14079421.json',
    joyful: 'joyful-robot-animation_14079418.json',
    inlove: 'inlove-robot-animation_14079419.json',
    angry: 'angry-robot-animation_14079422.json',
    sad: 'sad-robot-animation_14079423.json',
};
let currentMood = 'idle';
let lottieInstance = null;
let moodResetTimer = null;

// ============================================================
//  Default Settings
// ============================================================

const DEFAULT_SETTINGS = {
    enabled: true,
    debug: false,
    extractionInterval: 5,
    extractionMaxTokens: 4096,
    indexDepth: 9999,
    recallDepth: 2,
    maxPages: 3,
    showRecallBadges: true,
    // Compression
    autoCompress: true,
    compressAfterPages: 15,     // Compress oldest L0 pages when total L0 > this
    archiveAfterPages: 20,      // Archive oldest L1 pages when total L1 > this
    maxTimelineEntries: 20,     // Compress timeline when entries exceed this
    // Auto-hide: hide processed messages to free context
    autoHide: false,
    keepRecentMessages: 10,
    // Secondary API (副API) — OpenAI-compatible endpoint
    useSecondaryApi: false,
    secondaryApiUrl: '',
    secondaryApiKey: '',
    secondaryApiModel: '',
    secondaryApiTemperature: 0.3,
};

// ============================================================
//  Helpers
// ============================================================

function log(...args) {
    if (getSettings().debug) console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function generateId(prefix = 'pg') {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// ============================================================
//  Lottie Mood System
// ============================================================

async function loadLottieLib() {
    if (window.lottie) return;
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = LOTTIE_CDN;
        script.onload = resolve;
        script.onerror = () => { warn('Failed to load Lottie library from CDN'); resolve(); };
        document.head.appendChild(script);
    });
}

/**
 * Set the robot's mood animation.
 * @param {string} mood - One of: idle, thinking, joyful, inlove, angry, sad
 * @param {number} autoResetMs - If > 0, auto-reset to idle after this many ms
 */
function setMood(mood, autoResetMs = 0) {
    if (!MOOD_FILES[mood] || !window.lottie) return;
    if (mood === currentMood && lottieInstance) return;

    currentMood = mood;

    const container = document.getElementById('mm_lottie_container');
    if (!container) return;

    if (lottieInstance) {
        lottieInstance.destroy();
        lottieInstance = null;
    }

    const baseUrl = new URL('.', import.meta.url).pathname;
    lottieInstance = window.lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: `${baseUrl}lottie/${MOOD_FILES[mood]}`,
    });

    if (moodResetTimer) clearTimeout(moodResetTimer);
    if (autoResetMs > 0) {
        moodResetTimer = setTimeout(() => setMood('idle'), autoResetMs);
    }
}

function toggleSecondaryApiFields(show) {
    $('#mm_secondary_api_fields').toggle(show);
}

function toggleAutoHideFields(show) {
    $('#mm_auto_hide_fields').toggle(show);
}

// ============================================================
//  Lore Context (仅世界书，不含角色卡)
// ============================================================

async function gatherWorldBookContext() {
    // 只读取世界书条目（角色卡是角色设定，不是剧情记忆）
    try {
        const entries = await getSortedEntries();
        const activeEntries = entries?.filter(e => !e.disable && e.content?.trim());
        if (!activeEntries || activeEntries.length === 0) return '';

        // 按 position 分组，还原酒馆实际注入 prompt 时的区块顺序
        // position: 0=↑Char(角色定义前), 1=↓Char(角色定义后),
        //           2=↑AT, 3=↓AT, 4=@D(指定深度), 5=↑EM, 6=↓EM
        const positionLabels = {
            0: '角色定义前 (↑Char)',
            1: '角色定义后 (↓Char)',
            2: '作者注释顶部 (↑AT)',
            3: '作者注释底部 (↓AT)',
            4: '指定深度 (@D)',
            5: '扩展提示顶部 (↑EM)',
            6: '扩展提示底部 (↓EM)',
        };
        // 注入到 prompt 的实际顺序: 先角色定义前，再角色定义后，再其他
        const positionOrder = [0, 1, 2, 3, 4, 5, 6];

        const groups = new Map();
        for (const entry of activeEntries) {
            const pos = entry.position ?? 0;
            if (!groups.has(pos)) groups.set(pos, []);
            groups.get(pos).push(entry);
        }

        const parts = [];
        for (const pos of positionOrder) {
            const group = groups.get(pos);
            if (!group || group.length === 0) continue;

            const label = positionLabels[pos] || `位置 ${pos}`;
            parts.push(`=== ${label} ===`);
            // 组内按 order 升序（order小的在上面，和 prompt 中的实际位置一致）
            group.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            for (const entry of group) {
                const name = entry.comment || (entry.key || []).join('/') || '(无标题)';
                parts.push(`【${name}】${entry.content}`);
            }
        }

        return parts.join('\n');
    } catch (err) {
        warn('Failed to load world info:', err);
        return '';
    }
}

// ============================================================
//  Secondary API (副API) — OpenAI-compatible
// ============================================================

async function callLLM(systemPrompt, userPrompt, maxTokens = null) {
    const s = getSettings();

    if (s.useSecondaryApi && s.secondaryApiUrl && s.secondaryApiKey) {
        return await callSecondaryApi(systemPrompt, userPrompt, maxTokens);
    }

    // Fallback: use main API
    log('Using main API (no secondary API configured)');
    const fullPrompt = systemPrompt
        ? `${systemPrompt}\n\n${userPrompt}`
        : userPrompt;
    return await generateQuietPrompt(fullPrompt, false, true, null, null, maxTokens || s.extractionMaxTokens);
}

async function callSecondaryApi(systemPrompt, userPrompt, maxTokens) {
    const s = getSettings();
    const baseUrl = s.secondaryApiUrl
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions\/?$/, '');

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    log('Calling secondary API via server proxy:', baseUrl, 'model:', s.secondaryApiModel);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'openai',
            reverse_proxy: baseUrl,
            proxy_password: s.secondaryApiKey,
            model: s.secondaryApiModel || undefined,
            messages: messages,
            temperature: s.secondaryApiTemperature ?? 0.3,
            max_tokens: (maxTokens && maxTokens > 0) ? maxTokens : undefined,
            stream: false,
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Secondary API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const responseText = await response.text();
    let data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        warn('Failed to parse server response as JSON:', e.message, 'raw:', responseText.substring(0, 300));
        throw new Error(`Server response is not valid JSON: ${e.message}`);
    }

    let content = data.choices?.[0]?.message?.content;
    if (!content && typeof data === 'string') content = data;

    if (!content) {
        warn('Secondary API response structure:', JSON.stringify(data).substring(0, 500));
        throw new Error('Secondary API returned empty response');
    }

    log('Secondary API response length:', content.length);
    return content;
}

/**
 * Call secondary API with tool calling support.
 * Returns { content, toolCalls } where toolCalls is an array of parsed tool calls.
 */
async function callSecondaryApiWithTools(systemPrompt, userPrompt, tools, maxTokens) {
    const s = getSettings();
    const baseUrl = s.secondaryApiUrl
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions\/?$/, '');

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    log('Calling secondary API with tools:', tools.map(t => t.function.name));

    const body = {
        chat_completion_source: 'openai',
        reverse_proxy: baseUrl,
        proxy_password: s.secondaryApiKey,
        model: s.secondaryApiModel || undefined,
        messages: messages,
        temperature: s.secondaryApiTemperature ?? 0.3,
        max_tokens: (maxTokens && maxTokens > 0) ? maxTokens : undefined,
        stream: false,
        tools: tools,
        tool_choice: 'auto',
    };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Secondary API (tools) error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const responseText = await response.text();
    let data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        throw new Error(`Server response is not valid JSON: ${e.message}`);
    }

    const message = data.choices?.[0]?.message;
    const content = message?.content || '';
    const rawToolCalls = message?.tool_calls || [];

    // Parse tool call arguments
    const toolCalls = rawToolCalls.map(tc => {
        let args = {};
        try {
            args = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments || {};
        } catch (e) {
            warn('Failed to parse tool call arguments:', tc.function?.arguments);
        }
        return {
            name: tc.function?.name || '',
            arguments: args,
        };
    });

    log('Tool calls received:', toolCalls.length, toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments)})`));
    return { content, toolCalls };
}

async function testSecondaryApi() {
    const s = getSettings();
    if (!s.secondaryApiUrl || !s.secondaryApiKey) {
        toastr?.warning?.('请先填写副API地址和密钥', 'Memory Manager');
        return;
    }

    try {
        toastr?.info?.('正在测试副API连接...', 'Memory Manager');
        const result = await callSecondaryApi(
            '你是一个测试助手。',
            '请回复"连接成功"四个字。',
            50,
        );
        toastr?.success?.(`副API连接成功！回复: ${result.substring(0, 100)}`, 'Memory Manager');
    } catch (err) {
        toastr?.error?.(`副API连接失败: ${err.message}`, 'Memory Manager');
    }
}

// ============================================================
//  Settings
// ============================================================

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extension_settings[MODULE_NAME];
}

function loadSettings() {
    const s = getSettings();
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = val;
    }

    $('#mm_enabled').prop('checked', s.enabled);
    $('#mm_debug').prop('checked', s.debug);
    $('#mm_extraction_interval').val(s.extractionInterval);
    $('#mm_extraction_interval_value').text(s.extractionInterval);
    $('#mm_extraction_max_tokens').val(s.extractionMaxTokens);
    $('#mm_index_depth').val(s.indexDepth);
    $('#mm_recall_depth').val(s.recallDepth);
    $('#mm_max_pages').val(s.maxPages);
    $('#mm_max_pages_value').text(s.maxPages);
    $('#mm_show_recall_badges').prop('checked', s.showRecallBadges);

    // Compression
    $('#mm_auto_compress').prop('checked', s.autoCompress);

    // Auto-hide
    $('#mm_auto_hide').prop('checked', s.autoHide);
    $('#mm_keep_recent_messages').val(s.keepRecentMessages);
    toggleAutoHideFields(s.autoHide);

    // Secondary API
    $('#mm_use_secondary_api').prop('checked', s.useSecondaryApi);
    $('#mm_secondary_api_url').val(s.secondaryApiUrl);
    $('#mm_secondary_api_key').val(s.secondaryApiKey);
    $('#mm_secondary_api_model').val(s.secondaryApiModel);
    $('#mm_secondary_api_temperature').val(s.secondaryApiTemperature);
    toggleSecondaryApiFields(s.useSecondaryApi);
}

function saveSetting(key, value) {
    getSettings()[key] = value;
    saveSettingsDebounced();
}

function bindSettingsPanel() {
    $('#mm_enabled').on('change', function () { saveSetting('enabled', this.checked); });
    $('#mm_debug').on('change', function () { saveSetting('debug', this.checked); });
    $('#mm_extraction_interval').on('input', function () {
        const v = Number(this.value);
        $('#mm_extraction_interval_value').text(v);
        saveSetting('extractionInterval', v);
    });
    $('#mm_extraction_max_tokens').on('change', function () { saveSetting('extractionMaxTokens', Number(this.value)); });
    $('#mm_index_depth').on('change', function () { saveSetting('indexDepth', Number(this.value)); });
    $('#mm_recall_depth').on('change', function () { saveSetting('recallDepth', Number(this.value)); });
    $('#mm_max_pages').on('input', function () {
        const v = Number(this.value);
        $('#mm_max_pages_value').text(v);
        saveSetting('maxPages', v);
    });
    $('#mm_show_recall_badges').on('change', function () { saveSetting('showRecallBadges', this.checked); });
    $('#mm_auto_compress').on('change', function () { saveSetting('autoCompress', this.checked); });

    // Auto-hide bindings
    $('#mm_auto_hide').on('change', function () {
        saveSetting('autoHide', this.checked);
        toggleAutoHideFields(this.checked);
    });
    $('#mm_keep_recent_messages').on('change', function () { saveSetting('keepRecentMessages', Number(this.value)); });

    // Secondary API bindings
    $('#mm_use_secondary_api').on('change', function () {
        saveSetting('useSecondaryApi', this.checked);
        toggleSecondaryApiFields(this.checked);
    });
    $('#mm_secondary_api_url').on('change', function () { saveSetting('secondaryApiUrl', this.value.trim()); });
    $('#mm_secondary_api_key').on('change', function () { saveSetting('secondaryApiKey', this.value.trim()); });
    $('#mm_secondary_api_model').on('change', function () { saveSetting('secondaryApiModel', this.value.trim()); });
    $('#mm_secondary_api_temperature').on('change', function () { saveSetting('secondaryApiTemperature', Number(this.value)); });
    $('#mm_test_secondary_api').on('click', testSecondaryApi);

    // Action buttons
    $('#mm_force_extract').on('click', () => safeExtract(true));
    $('#mm_force_compress').on('click', () => safeCompress(true));
    $('#mm_initialize').on('click', performBatchInitialization);
    $('#mm_reset').on('click', onResetClick);
    $('#mm_export').on('click', onExportClick);
    $('#mm_import').on('click', onImportClick);
    $('#mm_edit_timeline').on('click', onEditTimelineClick);
}

// ============================================================
//  Data Layer
// ============================================================

function createDefaultData() {
    return {
        version: DATA_VERSION,

        // Timeline text (maintained by LLM, periodically compressed)
        timeline: '',

        // Character dossiers (full detail)
        characters: [],

        // Item list
        items: [],

        // Story pages (detailed event descriptions, progressively compressed)
        pages: [],

        // Processing state
        processing: {
            lastExtractedMessageId: -1,
            extractionInProgress: false,
        },

        // Per-message recall records (for UI display)
        messageRecalls: {},
    };
}

/**
 * Migrate v1 data (old storyBible structure) to v2 (PageIndex structure).
 */
function migrateV1toV2(oldData) {
    log('Migrating data from v1 to v2...');
    const newData = createDefaultData();

    // Migrate timeline
    if (oldData.storyBible?.timeline) {
        newData.timeline = oldData.storyBible.timeline;
    }

    // Migrate characters
    if (Array.isArray(oldData.storyBible?.characters)) {
        newData.characters = oldData.storyBible.characters.map(c => ({
            name: c.name || '',
            appearance: c.appearance || '',
            personality: c.personality || '',
            attitude: c.relationship || c.attitude || '',
            currentState: '',
        }));
    }

    // Migrate items
    if (Array.isArray(oldData.storyBible?.items)) {
        newData.items = oldData.storyBible.items.map(item => ({
            name: item.name || '',
            status: item.status || '',
            significance: item.significance || '',
        }));
    }

    // Migrate memories → pages
    if (Array.isArray(oldData.memories)) {
        newData.pages = oldData.memories
            .filter(m => m.status === 'active')
            .map(m => ({
                id: m.id || generateId(),
                day: m.day || '',
                title: m.title || '',
                content: m.content || '',
                keywords: m.tags || [],
                characters: [],
                significance: m.significance || 'medium',
                compressionLevel: COMPRESS_FRESH,
                sourceMessages: m.sourceMessages || [],
                createdAt: m.createdAt || Date.now(),
                compressedAt: null,
            }));
    }

    // Migrate processing state
    if (oldData.processing) {
        newData.processing = { ...newData.processing, ...oldData.processing };
    }

    // Migrate messageRecalls
    if (oldData.messageRecalls) {
        newData.messageRecalls = oldData.messageRecalls;
    }

    log('Migration complete. Pages:', newData.pages.length, 'Characters:', newData.characters.length);
    return newData;
}

function getMemoryData() {
    const ctx = getContext();
    if (!ctx.chatMetadata) return createDefaultData();
    if (!ctx.chatMetadata.memoryManager) {
        ctx.chatMetadata.memoryManager = createDefaultData();
    }
    let d = ctx.chatMetadata.memoryManager;

    // Handle migration from v1
    if (d.version !== DATA_VERSION) {
        if (d.version === 1 || d.storyBible) {
            d = migrateV1toV2(d);
            ctx.chatMetadata.memoryManager = d;
            saveMemoryData();
            log('Data migrated and saved');
        } else {
            d.version = DATA_VERSION;
        }
    }

    // Migrate character field: relationship → attitude (in-place for v2 data)
    if (Array.isArray(d.characters)) {
        for (const c of d.characters) {
            if (c.relationship && !c.attitude) {
                c.attitude = c.relationship;
                delete c.relationship;
            }
        }
    }

    return d;
}

function saveMemoryData() {
    saveMetadataDebounced();
}

// ============================================================
//  JSON Parsing (kept from v3)
// ============================================================

function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') {
        warn('parseJsonResponse: received non-string input:', typeof text, text);
        return null;
    }

    log('parseJsonResponse: input length =', text.length, 'preview:', text.substring(0, 150));

    // Strategy 1: markdown code block (greedy)
    const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]+)\n?\s*```/);
    if (blockMatch) {
        const raw = blockMatch[1].trim();
        log('Strategy 1: code block found, inner length =', raw.length);
        const fixed = fixJsonString(raw);
        try {
            const result = JSON.parse(fixed);
            log('Strategy 1: parse SUCCESS, keys:', Object.keys(result));
            return result;
        } catch (e) {
            warn('Strategy 1: code block parse failed:', e.message);
        }
    }

    // Strategy 2: bare JSON object (outermost braces)
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
        const raw = text.substring(braceStart, braceEnd + 1);
        log('Strategy 2: bare JSON found, length =', raw.length);
        const fixed = fixJsonString(raw);
        try {
            const result = JSON.parse(fixed);
            log('Strategy 2: parse SUCCESS, keys:', Object.keys(result));
            return result;
        } catch (e) {
            warn('Strategy 2: bare JSON parse failed:', e.message);
        }
    }

    // Strategy 3: aggressive fix — smart/curly quotes
    {
        const braceMatch = text.match(/\{[\s\S]*\}/);
        if (braceMatch) {
            let raw = braceMatch[0];
            raw = raw.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '\\"');
            raw = raw.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "\\'");
            const fixed = fixJsonString(raw);
            try {
                const result = JSON.parse(fixed);
                log('Strategy 3: aggressive fix SUCCESS, keys:', Object.keys(result));
                return result;
            } catch (e) {
                warn('Strategy 3: aggressive fix also failed:', e.message);
            }
        }
    }

    warn('Could not parse JSON from response. First 500 chars:', text.substring(0, 500));
    return null;
}

function fixJsonString(raw) {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];

        if (escaped) {
            result += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\' && inString) {
            result += ch;
            escaped = true;
            continue;
        }

        if (ch === '"') {
            if (!inString) {
                inString = true;
                result += ch;
            } else {
                // Peek ahead to decide: closing quote or content quote
                let j = i + 1;
                while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
                const next = raw[j];
                if (next === ':' || next === ',' || next === '}' || next === ']'
                    || next === '\n' || next === '\r' || next === undefined) {
                    inString = false;
                    result += ch;
                } else {
                    result += '\\"';
                }
            }
            continue;
        }

        if (inString) {
            if (ch === '\n') { result += '\\n'; continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { result += '\\t'; continue; }
        }

        result += ch;
    }

    result = result.replace(/,\s*([}\]])/g, '$1');
    return result;
}

// ============================================================
//  Story Index Formatting (for injection — compact, bounded)
// ============================================================

/**
 * Format the compact story index for injection.
 * Only timeline + items. Characters are fully on-demand via tool calling.
 * Target: ~400-600 tokens maximum.
 */
function formatStoryIndex(data, mentionedNames = null) {
    const parts = ['[故事索引]'];

    // Timeline (compact)
    if (data.timeline) {
        parts.push('一、剧情时间线');
        parts.push(data.timeline);
    }

    // Item index (compact)
    if (data.items.length > 0) {
        parts.push('\n二、物品');
        for (const item of data.items) {
            parts.push(`· ${item.name} | ${item.status || ''}`);
        }
    }

    // Character attitudes toward user (filtered to relevant characters)
    if (data.characters.length > 0) {
        const relevant = mentionedNames && mentionedNames.size > 0
            ? data.characters.filter(c => mentionedNames.has(c.name))
            : data.characters;
        if (relevant.length > 0) {
            parts.push('\n三、角色态度');
            for (const c of relevant) {
                if (c.attitude) {
                    parts.push(`· ${c.name}: ${c.attitude}`);
                }
            }
        }
    }

    parts.push('[/故事索引]');
    return parts.join('\n');
}

/**
 * Format selected pages for injection (recalled content).
 */
function formatRecalledPages(pages) {
    if (pages.length === 0) return '';

    const parts = ['[记忆闪回]'];
    for (const page of pages) {
        parts.push(`回忆起了……「${page.title}」(${page.day})`);
        parts.push(page.content);
        parts.push('');
    }
    parts.push('[/记忆闪回]');
    return parts.join('\n');
}

/**
 * Format character dossier for injection when character is relevant.
 */
function formatDossier(character) {
    const parts = [];
    parts.push(`[角色档案: ${character.name}]`);
    if (character.appearance) parts.push(`外貌: ${character.appearance}`);
    if (character.personality) parts.push(`性格: ${character.personality}`);
    if (character.currentState) parts.push(`当前状态: ${character.currentState}`);
    parts.push(`[/角色档案]`);
    return parts.join('\n');
}

// ============================================================
//  Extraction Engine
// ============================================================

function buildExtractionPrompt(data, newMessages) {
    const ctx = getContext();
    const userName = ctx.name1 || '{{user}}';

    const charsJson = data.characters.length > 0
        ? JSON.stringify(data.characters, null, 2)
        : '[]';
    const itemsJson = data.items.length > 0
        ? JSON.stringify(data.items, null, 2)
        : '[]';

    return `[OOC: 停止角色扮演。你现在是剧情记忆管理系统。请分析以下新消息，完成记忆提取。

## 当前故事索引

### 剧情时间线
${data.timeline || '（尚无，请从头创建）'}

### 登场人物（当前）
${charsJson}

### 重要物品（当前）
${itemsJson}

## 新消息内容
${newMessages}

## 任务

### 1. 更新时间线
基于现有时间线和新消息，输出更新后的完整时间线。
格式规则:
- 最近5天内的事件: 每天单独一行，格式 "D{天数}: 简述"
- 超过5天的旧事件: 合并为日期范围，格式 "D{起}-D{止}: 这段时期的综合概括"
- 只记录推动剧情的关键事件和转折，日常琐事不记录
- 保留所有旧条目的信息（可压缩措辞但不丢失关键事实）
- 按时间线排列
- 整个时间线控制在20行以内

### 2. 更新登场人物
更新NPC人物列表。**不要包含主角"${userName}"**，只记录NPC。
每个NPC:
- name: 角色名
- appearance: 外貌描写
- personality: 性格特征
- attitude: 该角色对主角（${userName}）的态度/关系变化轨迹（例如 "从冷漠对立 → 产生裂痕 → 逐渐信任"）
- currentState: 当前状态/情绪

### 3. 更新重要物品
如果有物品变动，更新物品列表。
每个物品: name, status, significance

### 4. 提取故事页（Story Pages）
从消息中提取值得深度记录的重大事件。每个页面是一个完整事件的详细叙事还原。
每个页面包含:
- title: 短标题（4-8字）
- day: 对应时间线中的D几
- content: 用文学叙事风格还原场景（80-200字），保留感官细节、情感氛围和因果关系
- keywords: 用于检索的关键词数组（3-8个，含角色名、地点、物品、情感关键词）
- significance: "high"（重要转折/关系变化）或 "medium"（值得记住但非关键）

如果没有值得记录的重要事件，newPages为空数组。

## 输出格式
严格按以下JSON格式输出，用markdown代码块包裹：

\`\`\`json
{
  "timeline": "D1-D3: 概括...\\nD4: ...\\nD5: ...",
  "characters": [
    {"name": "...", "appearance": "...", "personality": "...", "attitude": "...", "currentState": "..."}
  ],
  "items": [
    {"name": "...", "status": "...", "significance": "..."}
  ],
  "newPages": [
    {
      "title": "...",
      "day": "D1",
      "content": "...",
      "keywords": ["...", "..."],
      "significance": "high"
    }
  ]
}
\`\`\`

注意：
- 只输出JSON代码块，不要有其他文字
- 角色名使用实际名字，不用{{char}}或{{user}}
- **characters中不要包含主角"${userName}"**，只含NPC
- characters和items要输出完整列表（含未变化的旧条目）
- newPages仅包含本批消息中提取的新页面
- 时间线要严格控制行数: 旧事件压缩合并，近期事件保持独立
]`;
}

function buildInitExtractionPrompt(data, messages) {
    const ctx = getContext();
    const userName = ctx.name1 || '{{user}}';

    const charsJson = data.characters.length > 0
        ? JSON.stringify(data.characters, null, 2)
        : '[]';
    const itemsJson = data.items.length > 0
        ? JSON.stringify(data.items, null, 2)
        : '[]';

    return `[OOC: 停止角色扮演。你现在是剧情记忆管理系统。我正在从已有内容中批量构建记忆库，请分析以下内容。

## 当前故事索引（由之前的批次积累）

### 剧情时间线
${data.timeline || '（尚无，请从头创建）'}

### 登场人物（当前）
${charsJson}

### 重要物品（当前）
${itemsJson}

## 本批内容
${messages}

## 任务

### 1. 更新时间线
将本批内容中的事件整合进时间线。
格式规则:
- 格式 "D{天数}: 简述"，每行一条
- 只记录推动剧情的关键事件和转折
- 保留所有旧条目
- 按时间线排列

### 2. 更新登场人物
更新NPC人物列表。**不要包含主角"${userName}"**，只记录NPC。
每个NPC:
- name: 角色名
- appearance: 外貌描写
- personality: 性格特征
- attitude: 该角色对主角（${userName}）的态度/关系变化轨迹
- currentState: 当前状态/情绪

### 3. 更新重要物品
每个物品: name, status, significance

### 4. 提取故事页（重要！）
这是初始化流程。为本批内容中的所有重要事件创建故事页。
即使这些事件已经反映在时间线中，仍然需要创建对应的故事页。
每个重大转折、关系变化、情感高潮、关键对话都应该有一页。
每页包含:
- title: 短标题（4-8字）
- day: 对应时间线中的D几
- content: 用文学叙事风格还原场景（80-200字），保留因果关系与情感氛围
- keywords: 关键词数组（3-8个）
- significance: "high" 或 "medium"

## 输出格式
严格按JSON格式输出，用markdown代码块包裹：

\`\`\`json
{
  "timeline": "D1: ...\\nD2: ...",
  "characters": [
    {"name": "...", "appearance": "...", "personality": "...", "attitude": "...", "currentState": "..."}
  ],
  "items": [
    {"name": "...", "status": "...", "significance": "..."}
  ],
  "newPages": [
    {
      "title": "...",
      "day": "D1",
      "content": "...",
      "keywords": ["...", "..."],
      "significance": "high"
    }
  ]
}
\`\`\`

注意：
- 只输出JSON代码块，不要有其他文字
- 角色名使用实际名字
- **characters中不要包含主角"${userName}"**，只含NPC
- characters和items要输出完整列表
- newPages要为每个重要事件都创建，不要遗漏
]`;
}

function applyExtractionResult(data, result) {
    // Update timeline
    if (result.timeline) {
        data.timeline = result.timeline;
    }

    // Update characters (filter out protagonist)
    if (Array.isArray(result.characters) && result.characters.length > 0) {
        const ctx = getContext();
        const userName = (ctx.name1 || '').trim().toLowerCase();
        data.characters = result.characters
            .filter(c => c.name && c.name.trim().toLowerCase() !== userName)
            .map(c => ({
                name: c.name || '',
                appearance: c.appearance || '',
                personality: c.personality || '',
                attitude: c.attitude || c.relationship || '',
                currentState: c.currentState || '',
            }));
    }

    // Update items
    if (Array.isArray(result.items)) {
        data.items = result.items.map(item => ({
            name: item.name || '',
            status: item.status || '',
            significance: item.significance || '',
        }));
    }

    // Add new pages
    if (Array.isArray(result.newPages)) {
        for (const page of result.newPages) {
            if (!page.title || !page.content || page.content.length < 10) continue;
            const keywords = Array.isArray(page.keywords) ? page.keywords : [];
            if (keywords.length < 1) continue;

            // Extract character names from keywords
            const charNames = data.characters.map(c => c.name);
            const pageChars = keywords.filter(k => charNames.includes(k));

            data.pages.push({
                id: generateId('pg'),
                day: page.day || '',
                title: page.title,
                content: page.content,
                keywords: keywords,
                characters: pageChars,
                significance: page.significance || 'medium',
                compressionLevel: COMPRESS_FRESH,
                sourceMessages: [],
                createdAt: Date.now(),
                compressedAt: null,
            });
        }
    }
}

async function performExtraction() {
    const ctx = getContext();
    const data = getMemoryData();
    const lastId = data.processing.lastExtractedMessageId;

    const startIdx = Math.max(0, lastId + 1);
    const chat = ctx.chat;
    if (startIdx >= chat.length) return;

    const newMsgs = chat.slice(startIdx)
        .filter(m => !m.is_system)
        .map(m => `${m.name}: ${m.mes}`)
        .join('\n\n');

    if (!newMsgs.trim()) return;

    log('Extracting from messages', startIdx, 'to', chat.length - 1);

    const prompt = buildExtractionPrompt(data, newMsgs);
    const response = await callLLM(
        '你是剧情记忆管理系统。严格按要求输出JSON。',
        prompt,
        getSettings().extractionMaxTokens,
    );

    log('Extraction response length:', response?.length);

    const result = parseJsonResponse(response);
    if (!result) {
        throw new Error('Failed to parse extraction response');
    }

    applyExtractionResult(data, result);

    data.processing.lastExtractedMessageId = chat.length - 1;
    saveMemoryData();

    log('Extraction complete. Pages:', data.pages.length, 'Timeline updated.');

    // Run compression cycle after extraction
    if (getSettings().autoCompress) {
        await safeCompress(false);
    }

    updateBrowserUI();
}

let consecutiveFailures = 0;

async function safeExtract(force = false) {
    const s = getSettings();
    if (!s.enabled && !force) return;

    const data = getMemoryData();
    if (data.processing.extractionInProgress) {
        log('Extraction already in progress, skipping');
        return;
    }

    const ctx = getContext();
    if (!ctx.chat || ctx.chat.length === 0) return;

    const pendingCount = ctx.chat.length - 1 - data.processing.lastExtractedMessageId;
    if (!force && pendingCount < s.extractionInterval) return;

    if (is_send_press) {
        log('Send in progress, deferring extraction');
        return;
    }

    data.processing.extractionInProgress = true;
    saveMemoryData();
    setMood('thinking');

    try {
        await performExtraction();
        consecutiveFailures = 0;
        setMood('joyful', 5000);
        await hideProcessedMessages();
    } catch (err) {
        warn('Extraction failed:', err);
        setMood('sad', 5000);
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
            toastr?.warning?.('记忆提取连续失败，请检查API状态', 'Memory Manager');
            consecutiveFailures = 0;
        }
    } finally {
        data.processing.extractionInProgress = false;
        saveMemoryData();
        updateStatusDisplay();
    }
}

// ============================================================
//  Compression Engine (Progressive Compression)
// ============================================================

/**
 * Build prompt to compress a page from L0 (fresh) to L1 (summary).
 */
function buildPageCompressionPrompt(page) {
    return `[OOC: 将以下故事事件压缩为30-50字的精炼摘要。保留：谁、做了什么、为什么、结果如何。去除感官细节和修辞。

原文 (${page.day} - ${page.title}):
${page.content}

要求:
- 输出纯文本，不要JSON不要代码块
- 30-50字
- 保留因果关系和关键角色
- 不要丢失核心事实
]`;
}

/**
 * Build prompt to compress the timeline when it's too long.
 */
function buildTimelineCompressionPrompt(timeline, maxEntries) {
    return `[OOC: 以下剧情时间线条目过多，请压缩。

## 当前时间线
${timeline}

## 压缩规则
1. 最近5个条目保持不变
2. 更早的条目: 相邻的连续天数合并为范围 "D{起}-D{止}: 综合概括"
3. 合并后的条目用一句话概括该段时期的核心事件
4. 压缩后总行数不超过 ${maxEntries} 行
5. 不丢失任何重要转折点或关系变化

## 输出
只输出压缩后的时间线文本，每行一条。不要JSON，不要代码块，不要解释。
]`;
}

/**
 * Compress a single page from L0 to L1.
 */
async function compressPage(data, pageId) {
    const page = data.pages.find(p => p.id === pageId);
    if (!page || page.compressionLevel !== COMPRESS_FRESH) return;

    log('Compressing page:', page.title, '(', page.content.length, 'chars )');

    try {
        const prompt = buildPageCompressionPrompt(page);
        const compressed = await callLLM(
            '你是文本压缩助手。只输出压缩结果。',
            prompt,
            200,
        );

        if (compressed && compressed.trim().length > 10) {
            page.content = compressed.trim();
            page.compressionLevel = COMPRESS_SUMMARY;
            page.compressedAt = Date.now();
            log('Page compressed:', page.title, '→', page.content.length, 'chars');
        }
    } catch (err) {
        warn('Failed to compress page:', page.title, err);
    }
}

/**
 * Archive a page (L1 → L2): its info is already in timeline, delete the page.
 */
function archivePage(data, pageId) {
    const idx = data.pages.findIndex(p => p.id === pageId);
    if (idx === -1) return;

    const page = data.pages[idx];
    if (page.compressionLevel < COMPRESS_SUMMARY) return;

    log('Archiving page:', page.title);
    data.pages.splice(idx, 1);

    // Clean up messageRecalls referencing this page
    for (const [msgId, ids] of Object.entries(data.messageRecalls)) {
        const filtered = ids.filter(id => id !== pageId);
        if (filtered.length === 0) {
            delete data.messageRecalls[msgId];
        } else {
            data.messageRecalls[msgId] = filtered;
        }
    }
}

/**
 * Compress timeline text when it exceeds maxTimelineEntries.
 */
async function compressTimeline(data) {
    const s = getSettings();
    const lines = data.timeline.split('\n').filter(l => l.trim());

    if (lines.length <= s.maxTimelineEntries) return;

    log('Timeline has', lines.length, 'entries, compressing to', s.maxTimelineEntries);

    try {
        const prompt = buildTimelineCompressionPrompt(data.timeline, s.maxTimelineEntries);
        const compressed = await callLLM(
            '你是时间线压缩助手。只输出压缩后的时间线。',
            prompt,
            1000,
        );

        if (compressed && compressed.trim().length > 20) {
            const newLines = compressed.trim().split('\n').filter(l => l.trim());
            if (newLines.length <= lines.length) {
                data.timeline = compressed.trim();
                log('Timeline compressed:', lines.length, '→', newLines.length, 'entries');
            } else {
                warn('Timeline compression produced more lines, keeping original');
            }
        }
    } catch (err) {
        warn('Failed to compress timeline:', err);
    }
}

/**
 * Run a full compression cycle.
 */
async function runCompressionCycle(data, force = false) {
    const s = getSettings();
    if (!s.autoCompress && !force) return;

    log('Running compression cycle...');

    // 1. Compress timeline if too long
    await compressTimeline(data);

    // 2. Compress old L0 pages to L1
    const freshPages = data.pages
        .filter(p => p.compressionLevel === COMPRESS_FRESH)
        .sort((a, b) => a.createdAt - b.createdAt);

    if (freshPages.length > s.compressAfterPages) {
        const toCompress = freshPages.slice(0, freshPages.length - s.compressAfterPages);
        log('Compressing', toCompress.length, 'fresh pages to summary');
        for (const page of toCompress) {
            await compressPage(data, page.id);
            saveMemoryData();
        }
    }

    // 3. Archive old L1 pages to L2
    const summaryPages = data.pages
        .filter(p => p.compressionLevel === COMPRESS_SUMMARY)
        .sort((a, b) => a.createdAt - b.createdAt);

    if (summaryPages.length > s.archiveAfterPages) {
        const toArchive = summaryPages.slice(0, summaryPages.length - s.archiveAfterPages);
        log('Archiving', toArchive.length, 'summary pages');
        for (const page of toArchive) {
            archivePage(data, page.id);
        }
    }

    saveMemoryData();
    log('Compression cycle complete. Total pages:', data.pages.length);
}

async function safeCompress(force = false) {
    try {
        setMood('angry');
        const data = getMemoryData();
        await runCompressionCycle(data, force);
        setMood('idle');
        updateBrowserUI();
        if (force) {
            toastr?.success?.('压缩完成', 'Memory Manager');
        }
    } catch (err) {
        warn('Compression cycle failed:', err);
        setMood('sad', 5000);
        if (force) {
            toastr?.error?.('压缩失败: ' + err.message, 'Memory Manager');
        }
    }
}

// ============================================================
//  Auto-hide Processed Messages
// ============================================================

async function hideProcessedMessages() {
    const s = getSettings();
    if (!s.autoHide) return;

    const ctx = getContext();
    const data = getMemoryData();
    const lastExtracted = data.processing.lastExtractedMessageId;
    if (lastExtracted < 0) return;

    const chatLen = ctx.chat.length;
    const hideUpTo = Math.min(lastExtracted, chatLen - 1 - s.keepRecentMessages);
    if (hideUpTo < 0) return;

    let hiddenCount = 0;
    for (let i = 0; i <= hideUpTo; i++) {
        if (ctx.chat[i] && !ctx.chat[i].is_system) {
            hiddenCount++;
        }
    }

    if (hiddenCount === 0) return;

    log(`Auto-hiding messages 0-${hideUpTo} (keeping last ${s.keepRecentMessages} visible)`);
    await hideChatMessageRange(0, hideUpTo, false);
}

// ============================================================
//  Retrieval Engine (Tool Calling + Keyword Fallback)
// ============================================================

/**
 * Build the retrieval tools definition for the secondary API.
 */
function buildRetrievalTools(data) {
    const tools = [];

    // Tool 1: Recall a story page
    if (data.pages.length > 0) {
        const pageEnum = data.pages
            .filter(p => p.compressionLevel <= COMPRESS_SUMMARY)
            .map(p => p.id);

        if (pageEnum.length > 0) {
            tools.push({
                type: 'function',
                function: {
                    name: 'recall_story_page',
                    description: '检索一个故事页的详细内容，用于为当前对话提供历史事件的详细记忆。可多次调用以检索多个页面。',
                    parameters: {
                        type: 'object',
                        properties: {
                            page_id: {
                                type: 'string',
                                enum: pageEnum,
                                description: '要检索的故事页ID',
                            },
                        },
                        required: ['page_id'],
                    },
                },
            });
        }
    }

    // Tool 2: Recall a character dossier
    if (data.characters.length > 0) {
        const charEnum = data.characters.map(c => c.name);
        tools.push({
            type: 'function',
            function: {
                name: 'recall_character',
                description: '检索角色的详细档案（外貌、性格、关系变化、当前状态），用于当对话涉及该角色时提供完整信息。',
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            enum: charEnum,
                            description: '角色名',
                        },
                    },
                    required: ['name'],
                },
            },
        });
    }

    return tools;
}

/**
 * Build the retrieval prompt for tool-calling-based retrieval.
 * Shows story index + page catalog + recent conversation.
 */
function buildRetrievalPrompt(data, recentText) {
    const pageCatalog = data.pages
        .filter(p => p.compressionLevel <= COMPRESS_SUMMARY)
        .map(p => {
            const level = p.compressionLevel === COMPRESS_FRESH ? '详细' : '摘要';
            return `  [${p.id}] ${p.day} | ${p.title} | ${level} | keywords: ${p.keywords.join(',')}`;
        })
        .join('\n');

    const charCatalog = data.characters
        .map(c => `  ${c.name}: ${c.relationship || '(未知)'}`)
        .join('\n');

    return `你是记忆检索系统。根据当前对话语境，使用工具调用来检索需要的记忆。

## 故事索引（当前剧情全貌）
${formatStoryIndex(data)}

## 可检索的故事页
${pageCatalog || '(无可用页面)'}

## 可检索的角色档案
${charCatalog || '(无角色)'}

## 当前对话语境（最近几条消息）
${recentText}

## 指令
分析当前对话，判断需要检索哪些记忆来辅助AI回复：
- 使用 recall_story_page 检索与当前话题相关的故事页（最多3个）
- 使用 recall_character 检索当前互动角色的详细档案（最多2个）
- 如果当前对话不需要回忆旧事件或角色信息，则不调用任何工具

选择标准：
- 当前正在讨论或涉及的过去事件
- 当前互动角色的详细背景
- 可能影响对话走向的历史事件`;
}

/**
 * Tool-calling-based retrieval: secondary API uses tools to select pages/characters.
 */
async function toolCallRetrieve(data, recentText, maxPages) {
    try {
        if (data.pages.length === 0 && data.characters.length === 0) {
            return { pages: [], characters: [] };
        }

        const tools = buildRetrievalTools(data);
        if (tools.length === 0) return { pages: [], characters: [] };

        const prompt = buildRetrievalPrompt(data, recentText);
        const { toolCalls } = await callSecondaryApiWithTools(
            null,
            prompt,
            tools,
            300,
        );

        const selectedPages = [];
        const selectedChars = [];

        for (const tc of toolCalls) {
            if (tc.name === 'recall_story_page' && tc.arguments.page_id) {
                const page = data.pages.find(p => p.id === tc.arguments.page_id);
                if (page && selectedPages.length < maxPages) {
                    selectedPages.push(page);
                }
            } else if (tc.name === 'recall_character' && tc.arguments.name) {
                const char = data.characters.find(c => c.name === tc.arguments.name);
                if (char && selectedChars.length < 2) {
                    selectedChars.push(char);
                }
            }
        }

        log('Tool call retrieval:', selectedPages.map(p => p.title), selectedChars.map(c => c.name));
        return { pages: selectedPages, characters: selectedChars };
    } catch (err) {
        warn('Tool call retrieval failed, will fallback to keywords:', err);
        return { pages: [], characters: [] };
    }
}

/**
 * Keyword-based fallback retrieval (when no secondary API or tool calling fails).
 */
function keywordFallbackRetrieve(data, queryKeywords, maxPages) {
    const scored = data.pages
        .filter(p => p.compressionLevel <= COMPRESS_SUMMARY)
        .map(p => {
            let score = 0;
            for (const kw of (p.keywords || [])) {
                if (queryKeywords.has(kw)) score += 2;
                for (const q of queryKeywords) {
                    if (q !== kw && (q.includes(kw) || kw.includes(q))) score += 1;
                }
            }
            if (p.significance === 'high') score += 1;
            if (p.compressionLevel === COMPRESS_FRESH) score += 0.5;
            return { page: p, score };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

    const pages = scored.slice(0, maxPages).map(s => s.page);

    // Find relevant characters from selected pages + keyword matches
    const mentionedChars = new Set();
    for (const p of pages) {
        for (const c of (p.characters || [])) mentionedChars.add(c);
    }
    // Also check if any character name appears in keywords
    for (const c of data.characters) {
        if (queryKeywords.has(c.name)) mentionedChars.add(c.name);
    }
    const characters = data.characters.filter(c => mentionedChars.has(c.name)).slice(0, 2);

    return { pages, characters };
}

function extractQueryKeywords(recentMessages) {
    const text = recentMessages.map(m => m.mes || '').join(' ');
    const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}|[a-zA-Z]{3,}/g) || [];
    return new Set(matches);
}

// ============================================================
//  Injection (generate_interceptor)
// ============================================================

let lastRecalledPages = [];
let lastRecalledChars = [];

async function retrieveMemories(chat, contextSize, abort, type) {
    if (type === 'quiet') return;

    const s = getSettings();
    if (!s.enabled) return;

    const data = getMemoryData();

    // Extract recent messages for keyword/name analysis
    const recentCount = Math.min(5, chat.length);
    const recentMessages = chat.slice(-recentCount).filter(m => !m.is_system);
    const recentText = recentMessages.map(m => `${m.name}: ${m.mes}`).join('\n');

    // Find character names mentioned in recent messages (for attitude filtering in index)
    const mentionedNames = new Set();
    for (const c of data.characters) {
        if (recentText.includes(c.name)) mentionedNames.add(c.name);
    }

    // === Layer 1: Always inject Story Index (timeline + items + relevant attitudes) ===
    if (data.timeline || data.items.length > 0 || data.characters.length > 0) {
        const indexText = formatStoryIndex(data, mentionedNames);
        setExtensionPrompt(
            PROMPT_KEY_INDEX,
            indexText,
            extension_prompt_types.IN_CHAT,
            s.indexDepth,
            false,
            extension_prompt_roles.SYSTEM,
        );
    } else {
        setExtensionPrompt(PROMPT_KEY_INDEX, '', extension_prompt_types.IN_CHAT, 0);
    }

    // === Layer 2 & 3: Retrieve Pages + Character Dossiers ===
    if (data.pages.length === 0 && data.characters.length === 0) {
        setExtensionPrompt(PROMPT_KEY_PAGES, '', extension_prompt_types.IN_CHAT, 0);
        lastRecalledPages = [];
        lastRecalledChars = [];
        return;
    }

    let retrieved = { pages: [], characters: [] };

    if (s.useSecondaryApi && s.secondaryApiUrl && s.secondaryApiKey) {
        // Tool-calling retrieval: secondary API uses tools to select pages/characters
        retrieved = await toolCallRetrieve(data, recentText, s.maxPages);
    }

    // Fallback to keyword matching if tool calling returned nothing or no secondary API
    if (retrieved.pages.length === 0 && retrieved.characters.length === 0) {
        const queryKeywords = extractQueryKeywords(recentMessages);
        log('Keyword fallback, keywords:', [...queryKeywords]);
        retrieved = keywordFallbackRetrieve(data, queryKeywords, s.maxPages);
    }

    log('Retrieved pages:', retrieved.pages.map(p => p.title));
    log('Retrieved characters:', retrieved.characters.map(c => c.name));

    // Build injection text
    const injectionParts = [];

    if (retrieved.pages.length > 0) {
        injectionParts.push(formatRecalledPages(retrieved.pages));
    }

    if (retrieved.characters.length > 0) {
        for (const char of retrieved.characters) {
            injectionParts.push(formatDossier(char));
        }
    }

    if (injectionParts.length > 0) {
        setExtensionPrompt(
            PROMPT_KEY_PAGES,
            injectionParts.join('\n\n'),
            extension_prompt_types.IN_PROMPT,
            0,
            false,
            extension_prompt_roles.SYSTEM,
        );
    } else {
        setExtensionPrompt(PROMPT_KEY_PAGES, '', extension_prompt_types.IN_PROMPT, 0);
    }

    // Store for UI display
    lastRecalledPages = retrieved.pages;
    lastRecalledChars = retrieved.characters;
    updateRecallFab();

    // Update mood based on recall results
    const totalRecalled = retrieved.pages.length + retrieved.characters.length;
    if (totalRecalled >= 3) {
        setMood('inlove', 6000);
    } else if (totalRecalled > 0) {
        setMood('joyful', 5000);
    }

    // Record in messageRecalls for the next message
    const nextMessageId = chat.length;
    if (retrieved.pages.length > 0) {
        data.messageRecalls[nextMessageId] = retrieved.pages.map(p => p.id);
        saveMemoryData();
    }
}

// Register global interceptor
window['memoryManager_retrieveMemories'] = retrieveMemories;

// ============================================================
//  Recall Floating Ball (悬浮球)
// ============================================================

function updateRecallFab() {
    const fab = document.getElementById('mm_recall_fab');
    const countEl = document.getElementById('mm_recall_fab_count');
    if (!fab || !countEl) return;

    const total = lastRecalledPages.length + lastRecalledChars.length;
    if (total > 0) {
        fab.classList.add('has-recall');
        countEl.textContent = total;
        countEl.style.display = '';
    } else {
        fab.classList.remove('has-recall');
        countEl.style.display = 'none';
    }

    // Also update panel content if it's open
    updateRecallPanel();
}

function updateRecallPanel() {
    const body = document.getElementById('mm_recall_panel_body');
    if (!body) return;

    const total = lastRecalledPages.length + lastRecalledChars.length;
    if (total === 0) {
        body.innerHTML = '<div class="mm-empty-state">尚无召回内容</div>';
        return;
    }

    let html = '';

    if (lastRecalledPages.length > 0) {
        html += '<div class="mm-recall-panel-section">';
        html += `<div class="mm-recall-panel-section-title">故事页 (${lastRecalledPages.length})</div>`;
        for (const page of lastRecalledPages) {
            const dayHtml = page.day ? `<span class="mm-recall-panel-page-day">${page.day}</span>` : '';
            const contentEsc = (page.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += `<div class="mm-recall-panel-page">
                <div class="mm-recall-panel-page-header">
                    ${dayHtml}
                    <span class="mm-recall-panel-page-title">${(page.title || '').replace(/</g, '&lt;')}</span>
                </div>
                <div class="mm-recall-panel-page-body">${contentEsc}</div>
            </div>`;
        }
        html += '</div>';
    }

    if (lastRecalledChars.length > 0) {
        html += '<div class="mm-recall-panel-section">';
        html += `<div class="mm-recall-panel-section-title">角色档案 (${lastRecalledChars.length})</div>`;
        for (const char of lastRecalledChars) {
            const fields = [];
            if (char.appearance) fields.push(`<div>外貌: ${char.appearance.replace(/</g, '&lt;')}</div>`);
            if (char.personality) fields.push(`<div>性格: ${char.personality.replace(/</g, '&lt;')}</div>`);
            if (char.attitude) fields.push(`<div>态度: ${char.attitude.replace(/</g, '&lt;')}</div>`);
            if (char.currentState) fields.push(`<div>状态: ${char.currentState.replace(/</g, '&lt;')}</div>`);
            html += `<div class="mm-recall-panel-char">
                <div class="mm-recall-panel-char-name">${(char.name || '').replace(/</g, '&lt;')}</div>
                ${fields.join('')}
            </div>`;
        }
        html += '</div>';
    }

    body.innerHTML = html;
}

function bindRecallFab() {
    // 动态创建悬浮球和面板，直接挂到 body 上
    if (document.getElementById('mm_recall_fab')) return;

    const fab = document.createElement('div');
    fab.id = 'mm_recall_fab';
    fab.className = 'mm-recall-fab';
    fab.title = '查看本次记忆召回';
    fab.innerHTML = `
        <div id="mm_lottie_container" class="mm-lottie-container"></div>
        <span id="mm_recall_fab_count" class="mm-recall-fab-count" style="display:none">0</span>
    `;
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'mm_recall_panel';
    panel.className = 'mm-recall-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="mm-recall-panel-header">
            <span>本次记忆召回</span>
            <span id="mm_recall_panel_close" class="mm-recall-panel-close">&times;</span>
        </div>
        <div id="mm_recall_panel_body" class="mm-recall-panel-body">
            <div class="mm-empty-state">尚无召回内容</div>
        </div>
    `;
    document.body.appendChild(panel);

    // ── Drag & Snap logic ──
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let fabStartX = 0, fabStartY = 0;
    let hasMoved = false;

    function getFabRect() {
        return fab.getBoundingClientRect();
    }

    function snapToEdge(animate = true) {
        const rect = getFabRect();
        const centerX = rect.left + rect.width / 2;
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;

        // Snap to nearest horizontal edge
        let targetX, targetY;
        if (centerX < viewW / 2) {
            targetX = 8; // left edge
        } else {
            targetX = viewW - rect.width - 8; // right edge
        }

        // Clamp vertical position
        targetY = Math.max(8, Math.min(rect.top, viewH - rect.height - 8));

        if (animate) {
            fab.style.transition = 'left 0.3s ease, top 0.3s ease';
            requestAnimationFrame(() => {
                fab.style.left = targetX + 'px';
                fab.style.top = targetY + 'px';
                setTimeout(() => { fab.style.transition = ''; }, 300);
            });
        } else {
            fab.style.left = targetX + 'px';
            fab.style.top = targetY + 'px';
        }

        // Save position
        try {
            localStorage.setItem('mm_fab_pos', JSON.stringify({ x: targetX, y: targetY }));
        } catch (_) { /* ignore */ }
    }

    function onDragStart(clientX, clientY) {
        isDragging = true;
        hasMoved = false;
        dragStartX = clientX;
        dragStartY = clientY;
        const rect = getFabRect();
        fabStartX = rect.left;
        fabStartY = rect.top;
        fab.style.transition = '';
    }

    function onDragMove(clientX, clientY) {
        if (!isDragging) return;
        const dx = clientX - dragStartX;
        const dy = clientY - dragStartY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        if (!hasMoved) return;

        const viewW = window.innerWidth;
        const viewH = window.innerHeight;
        const size = fab.offsetWidth;
        const newX = Math.max(0, Math.min(fabStartX + dx, viewW - size));
        const newY = Math.max(0, Math.min(fabStartY + dy, viewH - size));
        fab.style.left = newX + 'px';
        fab.style.top = newY + 'px';
    }

    function onDragEnd() {
        if (!isDragging) return;
        isDragging = false;
        if (hasMoved) {
            snapToEdge(true);
        }
    }

    // Mouse events
    fab.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onDragStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => onDragMove(e.clientX, e.clientY));
    document.addEventListener('mouseup', () => onDragEnd());

    // Touch events (mobile)
    fab.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        onDragStart(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const t = e.touches[0];
        onDragMove(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchend', () => onDragEnd());

    // ── Click / Tap: toggle panel (only if not dragged) ──
    fab.addEventListener('click', () => {
        if (hasMoved) return; // was a drag, not a click
        const isOpen = panel.style.display !== 'none';
        if (isOpen) {
            panel.style.display = 'none';
        } else {
            updateRecallPanel();
            // Position panel near the fab
            const rect = getFabRect();
            const viewW = window.innerWidth;
            if (rect.left < viewW / 2) {
                panel.style.left = rect.left + 'px';
                panel.style.right = 'auto';
            } else {
                panel.style.left = 'auto';
                panel.style.right = (viewW - rect.right) + 'px';
            }
            panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
            panel.style.display = '';
        }
    });

    // ── Touch expression: show random expression on touch ──
    const touchMoods = ['joyful', 'inlove', 'wink'];
    fab.addEventListener('touchstart', () => {
        if (currentMood === 'thinking') return; // don't interrupt working states
        const randomMood = touchMoods[Math.floor(Math.random() * touchMoods.length)];
        setMood(randomMood, 3000);
    }, { passive: true });

    document.getElementById('mm_recall_panel_close')?.addEventListener('click', () => {
        panel.style.display = 'none';
    });

    // Restore saved position or default to bottom-right
    try {
        const saved = JSON.parse(localStorage.getItem('mm_fab_pos'));
        if (saved && typeof saved.x === 'number') {
            fab.style.left = saved.x + 'px';
            fab.style.top = saved.y + 'px';
        } else {
            fab.style.right = '24px';
            fab.style.bottom = '80px';
        }
    } catch (_) {
        fab.style.right = '24px';
        fab.style.bottom = '80px';
    }

    // Re-snap on window resize
    window.addEventListener('resize', () => snapToEdge(false));

    // Initialize Lottie animation
    loadLottieLib().then(() => setMood('idle'));
}

// ============================================================
//  Batch Initialization
// ============================================================

let initializationInProgress = false;

async function performBatchInitialization() {
    if (initializationInProgress) {
        toastr?.warning?.('初始化正在进行中，请耐心等待', 'Memory Manager');
        return;
    }

    const ctx = getContext();
    if (!ctx.chat || ctx.chat.length === 0) {
        toastr?.warning?.('当前没有聊天记录', 'Memory Manager');
        return;
    }

    const confirmed = confirm(
        '即将从现有聊天记录构建记忆库。\n\n'
        + '这将：\n'
        + '• 重置当前的记忆数据\n'
        + '• 分批处理所有消息（使用副API / 主API）\n'
        + '• 构建故事索引、故事页和角色档案\n\n'
        + '如聊天较长，可能需要多次API调用。是否继续？'
    );
    if (!confirmed) return;

    initializationInProgress = true;
    setMood('thinking');
    const s = getSettings();
    const CHUNK_SIZE = 20;
    const initMaxTokens = Math.max(s.extractionMaxTokens, 8192);

    // Reset data
    const data = getMemoryData();
    Object.assign(data, createDefaultData());
    data.processing.extractionInProgress = true;
    saveMemoryData();

    // Collect all non-system messages
    const allMessages = ctx.chat
        .map((m, i) => ({ msg: m, idx: i }))
        .filter(item => !item.msg.is_system && item.msg.mes);

    // Gather world book context (不含角色卡 — 角色卡是角色设定，不是剧情记忆)
    updateInitProgressUI(0, 0, '正在读取世界书...');
    const worldBookContext = await gatherWorldBookContext();

    // Build batch list
    const batches = [];

    // Batch 0: World book entries (plot summaries etc.)
    if (worldBookContext && worldBookContext.trim().length > 0) {
        batches.push({
            type: 'lore',
            text: worldBookContext,
            sourceIds: [],
            label: '世界书',
        });
    }

    // Chat message batches
    for (let i = 0; i < allMessages.length; i += CHUNK_SIZE) {
        const chunk = allMessages.slice(i, i + CHUNK_SIZE);
        batches.push({
            type: 'chat',
            text: chunk.map(item => `${item.msg.name}: ${item.msg.mes}`).join('\n\n'),
            sourceIds: chunk.map(item => item.idx),
            label: `聊天消息 ${i + 1}-${Math.min(i + CHUNK_SIZE, allMessages.length)}`,
            lastIdx: chunk[chunk.length - 1].idx,
        });
    }

    const totalBatches = batches.length;
    let successBatches = 0;

    toastr?.info?.(`开始初始化：${worldBookContext ? '含世界书，' : ''}共 ${allMessages.length} 条消息，分 ${totalBatches} 批处理...`, 'Memory Manager', { timeOut: 5000 });
    updateInitProgressUI(0, totalBatches, '开始处理...');

    try {
        for (let ci = 0; ci < totalBatches; ci++) {
            const batch = batches[ci];
            if (!batch.text.trim()) continue;

            updateInitProgressUI(ci, totalBatches, `正在处理第 ${ci + 1}/${totalBatches} 批 (${batch.label})...`);

            try {
                const prompt = buildInitExtractionPrompt(data, batch.text);
                console.warn(LOG_PREFIX, `Batch ${ci + 1} (${batch.label}): calling LLM (max_tokens=${initMaxTokens})...`);
                const response = await callLLM(
                    '你是剧情记忆管理系统。严格按要求输出JSON。',
                    prompt,
                    initMaxTokens,
                );

                console.warn(LOG_PREFIX, `Batch ${ci + 1}: LLM responded, length=${response?.length || 0}`);

                const result = parseJsonResponse(response);
                if (!result) {
                    warn(`Batch ${ci + 1}: Failed to parse response.`);
                    continue;
                }

                console.warn(LOG_PREFIX, `Batch ${ci + 1}: parsed OK — timeline=${!!result.timeline}, chars=${result.characters?.length || 0}, pages=${result.newPages?.length || 0}`);

                applyExtractionResult(data, result);

                // Tag source messages for new pages (only for chat batches)
                if (batch.type === 'chat' && batch.sourceIds.length > 0) {
                    const newPages = data.pages.filter(p => p.sourceMessages.length === 0);
                    for (const p of newPages) {
                        p.sourceMessages = batch.sourceIds;
                    }
                    data.processing.lastExtractedMessageId = batch.lastIdx;
                }

                saveMemoryData();
                successBatches++;
                log(`Batch ${ci + 1}/${totalBatches} done. Pages: ${data.pages.length}`);

            } catch (err) {
                warn(`Batch ${ci + 1} failed:`, err);
                toastr?.warning?.(`第 ${ci + 1} 批处理失败: ${err.message}`, 'Memory Manager');
            }
        }

        // Auto-hide
        if (s.autoHide && data.processing.lastExtractedMessageId >= 0) {
            await hideProcessedMessages();
        }

        updateInitProgressUI(totalBatches, totalBatches, '初始化完成！');
        setMood('inlove', 8000);
        toastr?.success?.(
            `初始化完成！处理 ${successBatches}/${totalBatches} 批，提取 ${data.pages.length} 个故事页`,
            'Memory Manager',
            { timeOut: 8000 },
        );

    } catch (err) {
        warn('Batch initialization error:', err);
        setMood('sad', 6000);
        toastr?.error?.('初始化过程出错: ' + err.message, 'Memory Manager');
    } finally {
        initializationInProgress = false;
        data.processing.extractionInProgress = false;
        saveMemoryData();
        updateBrowserUI();
        hideInitProgressUI();
    }
}

function updateInitProgressUI(current, total, text) {
    let container = document.getElementById('mm_init_progress');
    if (!container) return;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    container.style.display = 'block';
    container.innerHTML = `
        <div class="mm-init-progress-text">${escapeHtml(text)}</div>
        <div class="mm-init-progress-bar-track">
            <div class="mm-init-progress-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="mm-init-progress-pct">${pct}%</div>
    `;
}

function hideInitProgressUI() {
    const container = document.getElementById('mm_init_progress');
    if (container) {
        setTimeout(() => { container.style.display = 'none'; }, 3000);
    }
}

// ============================================================
//  Message Recall UI
// ============================================================

function buildRecallDisplay(messageId) {
    const data = getMemoryData();
    const recalledIds = data.messageRecalls?.[messageId];
    if (!recalledIds || recalledIds.length === 0) return;

    const s = getSettings();
    if (!s.showRecallBadges) return;

    const pages = data.pages.filter(p => recalledIds.includes(p.id));
    if (pages.length === 0) return;

    const messageEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageEl) return;

    const mesBlock = messageEl.querySelector('.mes_block');
    if (!mesBlock) return;

    mesBlock.querySelector('.mem-recall-display')?.remove();

    const container = document.createElement('div');
    container.className = 'mem-recall-display';

    const toggle = document.createElement('div');
    toggle.className = 'mem-recall-toggle';
    toggle.innerHTML = `
        <span class="mem-recall-icon">&#128173;</span>
        <span class="mem-recall-label">回忆了 ${pages.length} 个故事页</span>
        <span class="mem-recall-arrow">&#9660;</span>
    `;

    const content = document.createElement('div');
    content.className = 'mem-recall-content';

    for (const page of pages) {
        const levelLabel = page.compressionLevel === COMPRESS_FRESH ? '详细' : '摘要';
        const item = document.createElement('div');
        item.className = 'mem-recall-item';
        item.innerHTML = `
            <div class="mem-recall-item-header">
                <span class="mem-recall-item-day">${escapeHtml(page.day)}</span>
                <span class="mem-recall-item-title">${escapeHtml(page.title)}</span>
                <span class="mem-recall-item-sig mem-sig-${page.significance}">
                    ${page.significance === 'high' ? '!!' : '!'}
                </span>
                <span class="mem-recall-item-level">${levelLabel}</span>
            </div>
            <div class="mem-recall-item-body">${escapeHtml(page.content)}</div>
        `;
        content.appendChild(item);
    }

    toggle.addEventListener('click', () => {
        content.classList.toggle('open');
        toggle.querySelector('.mem-recall-arrow').classList.toggle('open');
    });

    container.appendChild(toggle);
    container.appendChild(content);
    mesBlock.appendChild(container);
}

function restoreRecallDisplays() {
    const data = getMemoryData();
    if (!data.messageRecalls) return;
    for (const messageId of Object.keys(data.messageRecalls)) {
        buildRecallDisplay(Number(messageId));
    }
}

// ============================================================
//  Memory Browser UI (Settings Panel)
// ============================================================

function updateBrowserUI() {
    const data = getMemoryData();

    // Timeline
    const timelineEl = document.getElementById('mm_bible_timeline');
    if (timelineEl) {
        timelineEl.textContent = data.timeline || '（尚无数据）';
    }

    // Characters
    const charsEl = document.getElementById('mm_bible_characters');
    if (charsEl) {
        if (data.characters.length === 0) {
            charsEl.innerHTML = '<span class="mm-empty-state">暂无人物数据</span>';
        } else {
            charsEl.innerHTML = data.characters.map(c => {
                const tip = [c.appearance, c.personality, c.relationship, c.currentState].filter(Boolean).join(' | ');
                return `<span class="mm-tag" title="${escapeHtml(tip)}">${escapeHtml(c.name)}</span>`;
            }).join('');
        }
    }

    // Items
    const itemsEl = document.getElementById('mm_bible_items');
    if (itemsEl) {
        if (data.items.length === 0) {
            itemsEl.innerHTML = '<span class="mm-empty-state">暂无物品数据</span>';
        } else {
            itemsEl.innerHTML = data.items.map(item =>
                `<span class="mm-tag" title="${escapeHtml(item.status || '')} | ${escapeHtml(item.significance || '')}">${escapeHtml(item.name)}</span>`
            ).join('');
        }
    }

    // Page stats
    const countEl = document.getElementById('mm_page_count');
    if (countEl) {
        countEl.textContent = data.pages.length;
    }

    const freshCountEl = document.getElementById('mm_fresh_count');
    if (freshCountEl) {
        freshCountEl.textContent = data.pages.filter(p => p.compressionLevel === COMPRESS_FRESH).length;
    }

    const compressedCountEl = document.getElementById('mm_compressed_count');
    if (compressedCountEl) {
        compressedCountEl.textContent = data.pages.filter(p => p.compressionLevel === COMPRESS_SUMMARY).length;
    }

    // Page list
    const listEl = document.getElementById('mm_page_list');
    if (listEl) {
        const allPages = data.pages.sort((a, b) => {
            // Sort by day then by creation time
            const dayA = parseInt(a.day?.replace(/\D/g, '') || '0');
            const dayB = parseInt(b.day?.replace(/\D/g, '') || '0');
            if (dayA !== dayB) return dayA - dayB;
            return a.createdAt - b.createdAt;
        });

        if (allPages.length === 0) {
            listEl.innerHTML = '<div class="mm-empty-state">暂无故事页</div>';
        } else {
            listEl.innerHTML = allPages.map(p => {
                const levelClass = p.compressionLevel === COMPRESS_FRESH ? 'mm-level-fresh' : 'mm-level-compressed';
                const levelLabel = p.compressionLevel === COMPRESS_FRESH ? '详细' : '摘要';
                return `
                <div class="mm-memory-card ${levelClass}" data-id="${p.id}">
                    <div class="mm-memory-card-header">
                        <span class="mm-memory-card-day">${escapeHtml(p.day)}</span>
                        <span class="mm-memory-card-title">${escapeHtml(p.title)}</span>
                        <span class="mm-memory-card-sig mm-sig-${p.significance}">
                            ${p.significance === 'high' ? '!!' : '!'}
                        </span>
                        <span class="mm-memory-card-level ${levelClass}">${levelLabel}</span>
                    </div>
                    <div class="mm-memory-card-tags">
                        ${(p.keywords || []).map(t => `<span class="mm-tag">${escapeHtml(t)}</span>`).join('')}
                    </div>
                    <div class="mm-memory-card-body">${escapeHtml(p.content)}</div>
                    <div class="mm-memory-card-actions">
                        <button class="mm-btn-edit" data-id="${p.id}">编辑</button>
                        <button class="mm-btn-danger mm-btn-delete" data-id="${p.id}">删除</button>
                    </div>
                </div>
            `}).join('');

            listEl.querySelectorAll('.mm-btn-delete').forEach(btn => {
                btn.addEventListener('click', () => onDeletePage(btn.dataset.id));
            });
            listEl.querySelectorAll('.mm-btn-edit').forEach(btn => {
                btn.addEventListener('click', () => onEditPage(btn.dataset.id));
            });
        }
    }

    updateStatusDisplay();
}

function updateStatusDisplay() {
    const ctx = getContext();
    const data = getMemoryData();
    const processed = data.processing.lastExtractedMessageId;
    const total = ctx.chat ? ctx.chat.length - 1 : 0;
    const pending = Math.max(0, total - processed);

    const statusEl = document.getElementById('mm_status_text');
    if (statusEl) {
        statusEl.textContent = getSettings().enabled ? '运行中' : '已禁用';
    }

    const processedEl = document.getElementById('mm_processed_count');
    if (processedEl) processedEl.textContent = Math.max(0, processed);

    const pendingEl = document.getElementById('mm_pending_count');
    if (pendingEl) pendingEl.textContent = pending;
}

// ============================================================
//  Page Edit/Delete/Export/Import
// ============================================================

async function onDeletePage(id) {
    const data = getMemoryData();
    const idx = data.pages.findIndex(p => p.id === id);
    if (idx === -1) return;

    const page = data.pages[idx];
    const confirmed = confirm(`确认删除故事页「${page.title}」？`);
    if (!confirmed) return;

    data.pages.splice(idx, 1);
    saveMemoryData();
    updateBrowserUI();
}

async function onEditPage(id) {
    const data = getMemoryData();
    const page = data.pages.find(p => p.id === id);
    if (!page) return;

    const newContent = prompt('编辑故事页内容:', page.content);
    if (newContent === null) return;

    page.content = newContent;
    saveMemoryData();
    updateBrowserUI();
}

async function onEditTimelineClick() {
    const data = getMemoryData();
    const current = data.timeline || '';
    const newText = prompt('编辑时间线:', current);
    if (newText === null) return;

    data.timeline = newText;
    saveMemoryData();
    updateBrowserUI();
}

async function onResetClick() {
    const confirmed = confirm('确认重置当前聊天的所有记忆数据？此操作不可撤销。');
    if (!confirmed) return;

    const ctx = getContext();
    ctx.chatMetadata.memoryManager = createDefaultData();
    saveMemoryData();

    setExtensionPrompt(PROMPT_KEY_INDEX, '', extension_prompt_types.IN_CHAT, 0);
    setExtensionPrompt(PROMPT_KEY_PAGES, '', extension_prompt_types.IN_CHAT, 0);

    updateBrowserUI();
    toastr?.success?.('记忆数据已重置', 'Memory Manager');
}

function onExportClick() {
    const data = getMemoryData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `memory-manager-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function onImportClick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const imported = JSON.parse(text);
            // Accept both v1 and v2 formats
            if (!imported.pages && !imported.storyBible && !imported.memories) {
                throw new Error('Invalid format');
            }
            const ctx = getContext();
            // If v1 format, migrate
            if (imported.storyBible || imported.version === 1) {
                ctx.chatMetadata.memoryManager = migrateV1toV2(imported);
            } else {
                ctx.chatMetadata.memoryManager = imported;
            }
            saveMemoryData();
            updateBrowserUI();
            toastr?.success?.('记忆数据已导入', 'Memory Manager');
        } catch (err) {
            toastr?.error?.('导入失败: ' + err.message, 'Memory Manager');
        }
    });
    input.click();
}

// ============================================================
//  Event Handlers
// ============================================================

async function onChatEvent(messageId) {
    if (!getSettings().enabled) return;
    setTimeout(() => safeExtract(false), 500);
}

function onChatChanged() {
    setExtensionPrompt(PROMPT_KEY_INDEX, '', extension_prompt_types.IN_CHAT, 0);
    setExtensionPrompt(PROMPT_KEY_PAGES, '', extension_prompt_types.IN_CHAT, 0);
    lastRecalledPages = [];
    lastRecalledChars = [];
    consecutiveFailures = 0;

    const data = getMemoryData();
    data.processing.extractionInProgress = false;

    // Re-inject story index for new chat
    if (data.timeline || data.characters.length > 0) {
        const s = getSettings();
        setExtensionPrompt(
            PROMPT_KEY_INDEX,
            formatStoryIndex(data),
            extension_prompt_types.IN_CHAT,
            s.indexDepth,
            false,
            extension_prompt_roles.SYSTEM,
        );
    }

    updateBrowserUI();
}

function onMessageRendered(messageId) {
    if (lastRecalledPages.length > 0) {
        const data = getMemoryData();
        if (!data.messageRecalls[messageId]) {
            data.messageRecalls[messageId] = lastRecalledPages.map(p => p.id);
            saveMemoryData();
        }
    }
    buildRecallDisplay(Number(messageId));
}

// ============================================================
//  Slash Commands
// ============================================================

function registerSlashCommands() {
    const ctx = getContext();
    if (!ctx.SlashCommandParser || !ctx.SlashCommand) {
        log('SlashCommandParser not available, skipping command registration');
        return;
    }

    const { SlashCommandParser, SlashCommand } = ctx;

    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-extract',
            callback: async () => {
                await safeExtract(true);
                return '记忆提取完成';
            },
            helpString: '强制执行记忆提取',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-recall',
            callback: async () => {
                if (lastRecalledPages.length === 0) return '当前没有召回的故事页';
                return lastRecalledPages.map(p => `[${p.day}] ${p.title}: ${p.content}`).join('\n\n');
            },
            helpString: '显示当前召回的故事页',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-index',
            callback: async () => {
                const data = getMemoryData();
                return formatStoryIndex(data) || '（故事索引为空）';
            },
            helpString: '显示当前故事索引',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-pages',
            callback: async () => {
                const data = getMemoryData();
                if (data.pages.length === 0) return '没有故事页';
                return data.pages.map(p => {
                    const level = ['详细', '摘要', '归档'][p.compressionLevel] || '?';
                    return `[${p.day}] ${p.title} (${p.significance}, ${level}) keywords: ${(p.keywords || []).join(',')}`;
                }).join('\n');
            },
            helpString: '列出所有故事页',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-compress',
            callback: async () => {
                await safeCompress(true);
                return '压缩完成';
            },
            helpString: '强制执行记忆压缩',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-reset',
            callback: async () => {
                onResetClick();
                return '';
            },
            helpString: '重置当前聊天的记忆数据',
        }));

        log('Slash commands registered');
    } catch (err) {
        warn('Failed to register slash commands:', err);
    }
}

// ============================================================
//  Initialization
// ============================================================

jQuery(async function () {
    try {
        const baseUrl = new URL('.', import.meta.url).pathname;
        const settingsHtml = await $.get(`${baseUrl}settings.html`);
        $('#extensions_settings2').append(settingsHtml);
    } catch (err) {
        warn('Failed to load settings HTML:', err);
    }

    loadSettings();
    bindSettingsPanel();
    bindRecallFab();

    // Register events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    for (const evt of [event_types.MESSAGE_DELETED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(evt, onChatEvent);
    }

    registerSlashCommands();
    updateBrowserUI();
    setTimeout(restoreRecallDisplays, 1000);

    log('Memory Manager v4.0 (PageIndex) initialized');
});

export { MODULE_NAME };
