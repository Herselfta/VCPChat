// modules/proactiveInbox.js
//
// Agent 主动联络收件箱（Proactive Inbox）
// ----------------------------------------------------------------
// 处理 VCPLog WebSocket 收到的 { type: 'agent_proactive_message' }：
//   1. 解析 agentName → VCPChat agentId（按 config.json 的 name 反向匹配）
//   2. 找/建该 agent 的「主动联络」专用 topic（config.topics[] 标记 isProactive:true）
//   3. 把消息追加进该 topic 的 history.json（与正常史条目同构，前端可渲染）
//   4. 标记 topic unread + 发未读/刷新事件到渲染进程
//
// 设计要点：
//   - 主动消息落在**专用 topic**，与日常聊天分离（阿漂拍板）。
//   - 用户在该 topic 里回复走正常聊天路径（前端 I.R.I.S. 人设+全工具），
//     下一次请求进入服务端会话影子 → 闭环。
//   - 非 VCPChat 客户端收不到此类型时，后端保留 agent_active_message 降级（通知条）。

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

// 主动联络 topic 的统一命名与标记
const PROACTIVE_TOPIC_MARKER = 'isProactive';
const PROACTIVE_TOPIC_NAME = '爱睿思的悄悄话'; // 由 agent 名动态生成，见 ensureProactiveTopic

let deps = null; // { agentDir, userDataDir, agentConfigManager, notify }
let nameToIdCache = new Map();
let nameToIdCacheStamp = 0;

function init(config = {}) {
  deps = {
    agentDir: config.agentDir,
    userDataDir: config.userDataDir,
    agentConfigManager: config.agentConfigManager || null,
    notify: config.notify || (() => {}),
  };
  nameToIdCache = new Map();
  nameToIdCacheStamp = 0;
}

function isValidAgentName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 100 &&
    !/[\\/\0\n\r\t]/.test(name) && name !== '.' && name !== '..';
}

/**
 * 按 config.json 的 name 反向匹配 agentId（遍历 AGENT_DIR）。
 * 结果带 5min 缓存；agent 列表几乎不变，避免每次消息都全盘读目录。
 * @param {string} agentName
 * @returns {Promise<string|null>}
 */
async function resolveAgentIdByName(agentName) {
  if (!deps || !deps.agentDir) return null;
  if (!isValidAgentName(agentName)) return null;
  const now = Date.now();
  if (now - nameToIdCacheStamp > 5 * 60 * 1000) {
    nameToIdCache = new Map();
    nameToIdCacheStamp = now;
  }
  if (nameToIdCache.has(agentName)) return nameToIdCache.get(agentName);

  try {
    const entries = await fs.readdir(deps.agentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidateId = entry.name;
      const configPath = path.join(deps.agentDir, candidateId, 'config.json');
      let match = null;
      if (deps.agentConfigManager && typeof deps.agentConfigManager.readAgentConfig === 'function') {
        try {
          const cfg = await deps.agentConfigManager.readAgentConfig(candidateId, { allowDefault: false });
          if (cfg && cfg.name === agentName) match = candidateId;
        } catch (_) { /* read fail -> fall through to fs */ }
      }
      if (!match && (await fs.pathExists(configPath))) {
        try {
          const cfg = await fs.readJson(configPath);
          if (cfg && cfg.name === agentName) match = candidateId;
        } catch (_) { /* ignore corrupt */ }
      }
      if (match) {
        nameToIdCache.set(agentName, match);
        return match;
      }
    }
  } catch (err) {
    console.error('[ProactiveInbox] resolveAgentIdByName failed:', err.message);
  }
  nameToIdCache.set(agentName, null);
  return null;
}

/**
 * 找该 agent 的主动联络 topic；没有则创建一个。
 * @param {string} agentId
 * @param {string} agentName
 * @returns {Promise<{topicId:string, created:boolean} | null>}
 */
async function ensureProactiveTopic(agentId, agentName) {
  if (!deps) return null;
  const topicName = PROACTIVE_TOPIC_NAME.replace('爱睿思', agentName);

  let config = null;
  if (deps.agentConfigManager && typeof deps.agentConfigManager.readAgentConfig === 'function') {
    try {
      config = await deps.agentConfigManager.readAgentConfig(agentId, { allowDefault: true });
    } catch (_) { config = null; }
  }
  if (!config) return null;

  const topics = Array.isArray(config.topics) ? config.topics : [];
  const existing = topics.find(t => t && t[PROACTIVE_TOPIC_MARKER] === true);
  if (existing) return { topicId: existing.id, created: false };

  const newTopicId = `topic_${Date.now()}`;
  const newTopic = {
    id: newTopicId,
    name: topicName,
    createdAt: Date.now(),
    locked: true,
    unread: false,
    creatorSource: 'proactive',
    [PROACTIVE_TOPIC_MARKER]: true,
  };

  if (deps.agentConfigManager && typeof deps.agentConfigManager.updateAgentConfig === 'function') {
    await deps.agentConfigManager.updateAgentConfig(agentId, existingConfig => ({
      ...existingConfig,
      topics: [newTopic, ...(Array.isArray(existingConfig.topics) ? existingConfig.topics : [])],
    }));
  } else {
    // 无 agentConfigManager 时直接写 config.json（带临时备份，原子替换）
    config.topics = [newTopic, ...topics];
    await writeConfigDirect(agentId, config);
  }

  // 建 history.json 空文件（对齐 chatHandlers create-new-topic-for-agent 行为）
  const historyDir = path.join(deps.userDataDir, agentId, 'topics', newTopicId);
  await fs.ensureDir(historyDir);
  await fs.writeJson(path.join(historyDir, 'history.json'), [], { spaces: 2 });

  return { topicId: newTopicId, created: true };
}

/** agentConfigManager 不可用时的直接写配置（尽力而为，带 .backup 与原子替换）。 */
async function writeConfigDirect(agentId, config) {
  const configPath = path.join(deps.agentDir, agentId, 'config.json');
  await fs.ensureDir(path.dirname(configPath));
  if (await fs.pathExists(configPath)) {
    try { await fs.copy(configPath, `${configPath}.backup`, { overwrite: true }); } catch (_) {}
  }
  const tmp = `${configPath}.tmp-${process.pid}`;
  await fs.writeJson(tmp, config, { spaces: 2 });
  await fs.move(tmp, configPath, { overwrite: true });
}

/**
 * 把一条主动消息追加进主动 topic 的 history.json。
 * 消息结构与正常 assistant 条目同构（role/name/content/timestamp/id + 扩展标记），
 * 前端 messagRenderer 能直接渲染。然后标记 unread + 通知渲染进程。
 * @param {string} agentId
 * @param {string} topicId
 * @param {string} agentName
 * @param {string} content
 * @param {object} [extra] 携带 scenario/runId/systemSource 等上下文
 * @returns {Promise<{success:boolean, messageId?:string} | {error:string}>}
 */
async function appendProactiveMessage(agentId, topicId, agentName, content, extra = {}) {
  if (!deps || !deps.userDataDir) return { error: 'ProactiveInbox not initialized.' };
  if (!isValidAgentName(agentName) || typeof content !== 'string' || !content.trim()) {
    return { error: 'Invalid proactive message payload.' };
  }

  const historyDir = path.join(deps.userDataDir, agentId, 'topics', topicId);
  const historyFile = path.join(historyDir, 'history.json');
  const messageId = `proactive-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  const entry = {
    role: 'assistant',
    name: agentName,
    agentId,
    content,
    timestamp: Date.now(),
    id: messageId,
    isThinking: false,
    isGroupMessage: false,
    finishReason: 'stop',
    proactive: true,
    scenario: extra.scenario || 'proactive',
    ...(extra.runId ? { runId: extra.runId } : {}),
    ...(extra.systemSource ? { systemSource: extra.systemSource } : {}),
  };

  try {
    await fs.ensureDir(historyDir);
    let history = [];
    try {
      history = await fs.readJson(historyFile);
    } catch (_) { history = []; }
    if (!Array.isArray(history)) history = [];
    history.push(entry);
    await fs.writeJson(historyFile, history, { spaces: 2 });
  } catch (err) {
    console.error('[ProactiveInbox] appendProactiveMessage failed:', err.message);
    return { error: err.message };
  }

  // 标记 topic unread（若 agentConfigManager 可用）
  if (deps.agentConfigManager && typeof deps.agentConfigManager.updateAgentConfig === 'function') {
    try {
      await deps.agentConfigManager.updateAgentConfig(agentId, existingConfig => ({
        ...existingConfig,
        topics: (Array.isArray(existingConfig.topics) ? existingConfig.topics : []).map(t =>
          t && t.id === topicId ? { ...t, unread: true } : t
        ),
      }));
    } catch (err) {
      console.warn('[ProactiveInbox] mark unread failed:', err.message);
    }
  }

  // 通知渲染进程：刷新历史 + 侧边未读 + toast
  if (deps.notify && typeof deps.notify === 'function') {
    try { deps.notify({ agentId, topicId, messageId, agentName, scenario: extra.scenario || 'proactive' }); } catch (_) {}
  }

  return { success: true, messageId };
}

/** 单测 / 调试辅助：清空 name→id 缓存。 */
function invalidateCache() {
  nameToIdCache = new Map();
  nameToIdCacheStamp = 0;
}

module.exports = {
  init,
  resolveAgentIdByName,
  ensureProactiveTopic,
  appendProactiveMessage,
  invalidateCache,
  PROACTIVE_TOPIC_MARKER,
  PROACTIVE_TOPIC_NAME,
};