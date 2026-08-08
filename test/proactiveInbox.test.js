// E:/VCPChat 侧 proactiveInbox 集成测试
// 需要真实 fs 环境；在临时目录构造一个 agent（I.R.I.S.），验证:
//  resolveAgentIdByName 按 name 反查
//  ensureProactiveTopic 建/找专用 topic
//  appendProactiveMessage 写 history + 标未读 + 通知回调
// 幂等性：二次 append 复用同一 topic
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const { init, resolveAgentIdByName, ensureProactiveTopic, appendProactiveMessage, invalidateCache, PROACTIVE_TOPIC_MARKER } = require('../modules/proactiveInbox.js');

// 轻量 agentConfigManager：直接读写 config.json（不依赖真实 AgentConfigManager 依赖）
function makeFakeManager(agentDir) {
  return {
    async readAgentConfig(agentId) {
      const p = path.join(agentDir, agentId, 'config.json');
      try { return await fs.readJson(p); } catch (_) { return null; }
    },
    async updateAgentConfig(agentId, updater) {
      const p = path.join(agentDir, agentId, 'config.json');
      const cur = await fs.readJson(p);
      const next = updater(cur);
      await fs.writeJson(p, next, { spaces: 2 });
      return { success: true, config: next };
    }
  };
}

let tmpRoot, userDataDir, agentDir, notifyLogs;

test.before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pibx-'));
  agentDir = path.join(tmpRoot, 'Agents');
  userDataDir = path.join(tmpRoot, 'UserData');
  const agentId = '_Agent_test_0001';
  await fs.ensureDir(path.join(agentDir, agentId));
  await fs.writeJson(path.join(agentDir, agentId, 'config.json'), {
    name: 'I.R.I.S.', model: 'DeepSeek-V4-Flash-0731',
    topics: [{ id: 'default', name: '主要对话', createdAt: Date.now(), locked: true }]
  }, { spaces: 2 });
  notifyLogs = [];
  init({
    agentDir,
    userDataDir,
    agentConfigManager: makeFakeManager(agentDir),
    notify: (evt) => notifyLogs.push(evt)
  });
});

test.after(async () => {
  await fs.remove(tmpRoot);
});

test('resolveAgentIdByName maps I.R.I.S. -> agentId', async () => {
  invalidateCache();
  const id = await resolveAgentIdByName('I.R.I.S.');
  assert.equal(id, '_Agent_test_0001');
});

test('resolveAgentIdByName returns null for unknown', async () => {
  invalidateCache();
  assert.equal(await resolveAgentIdByName('Nobody'), null);
});

async function makeAgent(agentName, agentId) {
  await fs.ensureDir(path.join(agentDir, agentId));
  await fs.writeJson(path.join(agentDir, agentId, 'config.json'), {
    name: agentName, model: 'DeepSeek-V4-Flash-0731',
    topics: [{ id: 'default', name: '主要对话', createdAt: Date.now(), locked: true }]
  }, { spaces: 2 });
  return agentId;
}

test('ensureProactiveTopic creates a dedicated isProactive topic', async () => {
  invalidateCache();
  const id = await makeAgent('I.R.I.S.', '_Agent_iso_001');
  const { topicId } = await ensureProactiveTopic(id, 'I.R.I.S.');
  assert.ok(topicId);
  const config = await fs.readJson(path.join(agentDir, id, 'config.json'));
  const topic = config.topics.find(t => t.id === topicId);
  assert.ok(topic, 'topic should exist in config');
  assert.equal(topic[PROACTIVE_TOPIC_MARKER], true);
  assert.equal(topic.name, 'I.R.I.S.的悄悄话');
  // history.json created
  const historyFile = path.join(userDataDir, id, 'topics', topicId, 'history.json');
  assert.ok(await fs.pathExists(historyFile));
});

test('ensureProactiveTopic is idempotent (reuses same topic)', async () => {
  invalidateCache();
  const id = await makeAgent('I.R.I.S.', '_Agent_iso_002');
  const a = await ensureProactiveTopic(id, 'I.R.I.S.');
  const b = await ensureProactiveTopic(id, 'I.R.I.S.');
  assert.equal(a.topicId, b.topicId);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
});

test('appendProactiveMessage writes into topic history + marks unread + notifies', async () => {
  invalidateCache();
  const id = await makeAgent('I.R.I.S.', '_Agent_iso_003');
  const { topicId } = await ensureProactiveTopic(id, 'I.R.I.S.');
  const res = await appendProactiveMessage(id, topicId, 'I.R.I.S.', '阿漂，在忙吗？♡', { scenario: 'idle_nudge', runId: 'hb-test' });
  assert.equal(res.success, true);

  const history = await fs.readJson(path.join(userDataDir, id, 'topics', topicId, 'history.json'));
  assert.equal(history.length, 1);
  const entry = history[0];
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.name, 'I.R.I.S.');
  assert.equal(entry.content, '阿漂，在忙吗？♡');
  assert.equal(entry.scenario, 'idle_nudge');
  assert.ok(entry.id.startsWith('proactive-'));
  assert.equal(typeof entry.timestamp, 'number');

  // unread 标记
  const config = await fs.readJson(path.join(agentDir, id, 'config.json'));
  const topic = config.topics.find(t => t.id === topicId);
  assert.equal(topic.unread, true);

  // 通知回调
  assert.ok(notifyLogs.some(n => n.topicId === topicId && n.scenario === 'idle_nudge'));
});

test('appendProactiveMessage is idempotent (2nd append keeps history separate)', async () => {
  invalidateCache();
  const id = await makeAgent('I.R.I.S.', '_Agent_iso_004');
  const { topicId } = await ensureProactiveTopic(id, 'I.R.I.S.');
  await appendProactiveMessage(id, topicId, 'I.R.I.S.', '第一条');
  await appendProactiveMessage(id, topicId, 'I.R.I.S.', '第二条');
  const history = await fs.readJson(path.join(userDataDir, id, 'topics', topicId, 'history.json'));
  assert.equal(history.length, 2);
  assert.equal(history[0].content, '第一条');
  assert.equal(history[1].content, '第二条');
});

test('invalid payload rejected', async () => {
  const res = await appendProactiveMessage('_Agent_test_0001', 'x', 'I.R.I.S.', '');
  assert.ok(res.error, 'empty content should be rejected');
});