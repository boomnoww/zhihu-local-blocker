importScripts("../common.js");

const {
  STORAGE_KEYS,
  MESSAGE_TYPES,
  BLOCK_SOURCE,
  DEFAULT_SETTINGS,
  nowIso,
  buildEntry,
  extractProfile,
  isDebugAuditEntry,
  tokenAliasesFromUserLike,
  uniqueUsers
} = globalThis.ZLB;

const MEMBER_HASH_RE = /^[0-9a-f]{32}$/i;
const OFFICIAL_UNAVAILABLE_ERROR = "缺少可用于官方拉黑的知乎 url_token";

async function storageGet(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
}

async function storageSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function getSettings() {
  const saved = await storageGet(STORAGE_KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

async function updateSettings(patch) {
  const settings = await getSettings();
  const next = { ...settings, ...(patch || {}) };
  await storageSet(STORAGE_KEYS.settings, next);
  if (patch && patch.debugLoggingEnabled === false) {
    const log = await storageGet(STORAGE_KEYS.auditLog, []);
    await storageSet(STORAGE_KEYS.auditLog, log.filter((entry) => !isDebugAuditEntry(entry)));
  }
  return next;
}

async function getBlacklist() {
  return await storageGet(STORAGE_KEYS.blacklist, {});
}

async function setBlacklist(blacklist) {
  await storageSet(STORAGE_KEYS.blacklist, blacklist || {});
}

function findExistingTokenByAliases(blacklist, user) {
  const aliases = new Set(tokenAliasesFromUserLike(user));
  if (!aliases.size) {
    return user && user.token;
  }
  for (const entry of Object.values(blacklist || {})) {
    if (!entry || !entry.token) {
      continue;
    }
    const entryAliases = tokenAliasesFromUserLike(entry);
    if (entryAliases.some((alias) => aliases.has(alias))) {
      return entry.token;
    }
  }
  return user && user.token;
}

function preferUserToken(existing, user) {
  if (!existing || !existing.token || !user || !user.token) {
    return user;
  }
  const existingMatch = String(existing.token).match(/^people:(.+)$/);
  const userMatch = String(user.token).match(/^people:(.+)$/);
  const existingLooksInternal = existingMatch && MEMBER_HASH_RE.test(existingMatch[1]);
  const userLooksCanonical = userMatch && !MEMBER_HASH_RE.test(userMatch[1]);
  if (existingLooksInternal && userLooksCanonical) {
    return user;
  }
  return {
    ...user,
    token: existing.token,
    urlToken: existing.urlToken || user.urlToken,
    kind: existing.kind || user.kind,
    profileUrl: existing.profileUrl || user.profileUrl
  };
}

async function upsertUsers(users, source, meta) {
  const blacklist = await getBlacklist();
  let added = 0;
  let updated = 0;
  for (const user of uniqueUsers(users)) {
    const existingToken = findExistingTokenByAliases(blacklist, user);
    const existing = existingToken ? blacklist[existingToken] : null;
    const storageUser = preferUserToken(existing, user);
    const next = buildEntry(existing, storageUser, source, meta);
    if (existingToken && existingToken !== next.token) {
      delete blacklist[existingToken];
    }
    blacklist[next.token] = next;
    if (existing) {
      updated += 1;
    } else {
      added += 1;
    }
  }
  await setBlacklist(blacklist);
  return {
    added,
    updated,
    total: Object.keys(blacklist).length,
    blacklist
  };
}

async function removeUser(token) {
  const blacklist = await getBlacklist();
  const existed = Object.prototype.hasOwnProperty.call(blacklist, token);
  delete blacklist[token];
  await setBlacklist(blacklist);
  return {
    removed: existed,
    total: Object.keys(blacklist).length,
    blacklist
  };
}

async function getOfficialQueue() {
  return await storageGet(STORAGE_KEYS.officialQueue, {});
}

async function setOfficialQueue(queue) {
  await storageSet(STORAGE_KEYS.officialQueue, queue || {});
}

async function getBatchTasks() {
  return await storageGet(STORAGE_KEYS.batchTasks, {});
}

async function setBatchTasks(tasks) {
  await storageSet(STORAGE_KEYS.batchTasks, tasks || {});
}

async function updateBatchTask(id, patch) {
  if (!id) {
    throw new Error("Missing batch task id");
  }
  const tasks = await getBatchTasks();
  const previous = tasks[id] || {};
  tasks[id] = {
    ...previous,
    ...(patch || {}),
    id,
    createdAt: previous.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  await setBatchTasks(tasks);
  return {
    task: tasks[id],
    tasks
  };
}

async function clearBatchTask(id) {
  const tasks = await getBatchTasks();
  const existed = Object.prototype.hasOwnProperty.call(tasks, id);
  delete tasks[id];
  await setBatchTasks(tasks);
  return {
    cleared: existed,
    tasks
  };
}

function isMemberHash(value) {
  return MEMBER_HASH_RE.test(String(value || ""));
}

function addProfileUrlToken(candidates, value) {
  const profile = extractProfile(value || "");
  if (profile && profile.kind === "people") {
    candidates.push(profile.urlToken);
  }
}

function officialUrlTokenFor(user, entry) {
  const candidates = [];
  addProfileUrlToken(candidates, user && user.profileUrl);
  addProfileUrlToken(candidates, entry && entry.profileUrl);
  for (const profileUrl of [
    ...(((user && user.meta && user.meta.profileUrls) || [])),
    ...(((entry && entry.meta && entry.meta.profileUrls) || []))
  ]) {
    addProfileUrlToken(candidates, profileUrl);
  }
  candidates.push(user && user.urlToken, entry && entry.urlToken);
  for (const urlToken of [
    ...(((user && user.meta && user.meta.aliasUrlTokens) || [])),
    ...(((entry && entry.meta && entry.meta.aliasUrlTokens) || []))
  ]) {
    candidates.push(urlToken);
  }
  const tokenMatch = String((user && user.token) || (entry && entry.token) || "").match(/^people:(.+)$/);
  candidates.push(tokenMatch && tokenMatch[1]);
  return String(candidates.find((candidate) => {
    const value = String(candidate || "");
    return value && !/[/?#]/.test(value) && !isMemberHash(value);
  }) || "");
}

function hasSettingsFilterSource(entry) {
  return Array.isArray(entry && entry.sources) && entry.sources.includes(BLOCK_SOURCE.settingsFilter);
}

function asOfficialImportedEntry(entry) {
  return {
    ...entry,
    officialBlockStatus: "succeeded",
    officialBlockError: "",
    updatedAt: nowIso()
  };
}

function asOfficialUnavailableEntry(entry, error) {
  return {
    ...entry,
    officialBlockStatus: "unavailable",
    officialBlockError: error || OFFICIAL_UNAVAILABLE_ERROR,
    updatedAt: nowIso()
  };
}

function normalizeOfficialImportedEntries(blacklist, queue) {
  let migrated = 0;
  let removedQueued = 0;
  for (const entry of Object.values(blacklist || {})) {
    if (!entry || !entry.token || !hasSettingsFilterSource(entry)) {
      continue;
    }
    if (entry.officialBlockStatus !== "succeeded" || entry.officialBlockError) {
      blacklist[entry.token] = asOfficialImportedEntry(entry);
      migrated += 1;
    }
    if (queue && queue[entry.token]) {
      delete queue[entry.token];
      removedQueued += 1;
    }
  }
  return { migrated, removedQueued };
}

function normalizeUnsyncableOfficialQueueEntries(blacklist, queue) {
  let markedUnavailable = 0;
  let removedQueued = 0;
  for (const [token, item] of Object.entries(queue || {})) {
    const entry = (blacklist && blacklist[token]) || item;
    if (!entry || hasSettingsFilterSource(entry)) {
      continue;
    }
    if (officialUrlTokenFor(item, entry)) {
      continue;
    }
    delete queue[token];
    removedQueued += 1;
    if (blacklist && blacklist[token]) {
      blacklist[token] = asOfficialUnavailableEntry(blacklist[token]);
      markedUnavailable += 1;
    }
  }
  return { markedUnavailable, removedQueued };
}

async function enqueueOfficialBlocks(users, source) {
  const blacklist = await getBlacklist();
  const queue = await getOfficialQueue();
  let queued = 0;
  let skipped = 0;
  for (const user of uniqueUsers(users)) {
    const userKind = user.kind || (String(user.token || "").startsWith("people:") ? "people" : "");
    if (!user.token || userKind !== "people") {
      skipped += 1;
      continue;
    }
    const existingToken = findExistingTokenByAliases(blacklist, user);
    const existing = existingToken ? blacklist[existingToken] : null;
    const storageUser = preferUserToken(existing, user);
    const entry = buildEntry(existing, storageUser, source);
    if (existingToken && existingToken !== entry.token) {
      delete blacklist[existingToken];
      delete queue[existingToken];
    }
    if (hasSettingsFilterSource(entry) || source === BLOCK_SOURCE.settingsFilter || entry.officialBlockStatus === "succeeded") {
      if (queue[entry.token]) {
        delete queue[entry.token];
      }
      blacklist[entry.token] = asOfficialImportedEntry(entry);
      skipped += 1;
      continue;
    }
    const urlToken = officialUrlTokenFor(storageUser, entry);
    if (!urlToken) {
      if (queue[entry.token]) {
        delete queue[entry.token];
      }
      blacklist[entry.token] = asOfficialUnavailableEntry(entry);
      skipped += 1;
      continue;
    }
    queue[entry.token] = {
      token: entry.token,
      urlToken,
      kind: entry.kind || "people",
      profileUrl: entry.profileUrl || `https://www.zhihu.com/people/${urlToken}`,
      displayName: entry.displayName,
      source,
      status: "queued",
      attempts: queue[entry.token] ? queue[entry.token].attempts || 0 : 0,
      lastError: queue[entry.token] ? queue[entry.token].lastError || "" : "",
      createdAt: queue[entry.token] ? queue[entry.token].createdAt : nowIso(),
      updatedAt: nowIso()
    };
    blacklist[entry.token] = {
      ...entry,
      officialBlockStatus: "queued",
      officialBlockError: "",
      updatedAt: nowIso()
    };
    queued += 1;
  }
  await setOfficialQueue(queue);
  await setBlacklist(blacklist);
  return {
    queued,
    skipped,
    queue
  };
}

async function enqueuePendingOfficialBlocks(source) {
  const blacklist = await getBlacklist();
  const queue = await getOfficialQueue();
  const normalized = normalizeOfficialImportedEntries(blacklist, queue);
  const unsyncable = normalizeUnsyncableOfficialQueueEntries(blacklist, queue);
  if (normalized.migrated || normalized.removedQueued || unsyncable.markedUnavailable || unsyncable.removedQueued) {
    await setBlacklist(blacklist);
    await setOfficialQueue(queue);
  }
  const users = Object.values(blacklist || {}).filter((entry) => {
    const entryKind = entry && (entry.kind || (String(entry.token || "").startsWith("people:") ? "people" : ""));
    if (!entry || entryKind !== "people" || !entry.token) {
      return false;
    }
    if (entry.officialBlockStatus === "succeeded") {
      return false;
    }
    const urlToken = officialUrlTokenFor(entry, entry);
    return Boolean(urlToken && !/[/?#]/.test(urlToken));
  });
  const result = await enqueueOfficialBlocks(users, source || "pending-official");
  return {
    ...result,
    migratedOfficialImported: normalized.migrated,
    removedQueuedOfficialImported: normalized.removedQueued,
    markedOfficialUnavailable: unsyncable.markedUnavailable,
    removedQueuedOfficialUnavailable: unsyncable.removedQueued
  };
}

async function markOfficialResult(payload) {
  const queue = await getOfficialQueue();
  const blacklist = await getBlacklist();
  const token = payload && payload.token;
  if (!token) {
    throw new Error("Missing token");
  }
  const previous = queue[token] || {};
  const status = payload.status || "failed";
  queue[token] = {
    ...previous,
    token,
    status,
    attempts: Number(previous.attempts || 0) + 1,
    lastError: payload.error || "",
    updatedAt: nowIso()
  };
  if (["succeeded", "unavailable", "skipped"].includes(status)) {
    delete queue[token];
  }
  if (blacklist[token]) {
    blacklist[token] = {
      ...blacklist[token],
      officialBlockStatus: status,
      officialBlockError: payload.error || "",
      updatedAt: nowIso()
    };
  }
  await setOfficialQueue(queue);
  await setBlacklist(blacklist);
  return {
    queue,
    blacklist
  };
}

async function appendAuditLog(entry) {
  const settings = await getSettings();
  if (isDebugAuditEntry(entry) && !settings.debugLoggingEnabled) {
    return { skipped: true };
  }
  const log = await storageGet(STORAGE_KEYS.auditLog, []);
  log.unshift({
    ...entry,
    at: nowIso()
  });
  await storageSet(STORAGE_KEYS.auditLog, log.slice(0, 500));
  return log;
}

async function clearAuditLog() {
  await storageSet(STORAGE_KEYS.auditLog, []);
  return [];
}

function summarizeQueue(queue) {
  const values = Object.values(queue || {});
  return {
    queued: values.filter((item) => item.status === "queued").length,
    failed: values.filter((item) => item.status === "failed").length,
    total: values.length
  };
}

async function getState() {
  const [settings, blacklist, queue, batchTasks, auditLog] = await Promise.all([
    getSettings(),
    getBlacklist(),
    getOfficialQueue(),
    getBatchTasks(),
    storageGet(STORAGE_KEYS.auditLog, [])
  ]);
  const visibleAuditLog = settings.debugLoggingEnabled
    ? auditLog
    : auditLog.filter((entry) => !isDebugAuditEntry(entry));
  return {
    settings,
    blacklist,
    queue,
    batchTasks,
    auditLog: visibleAuditLog,
    summary: {
      blacklistTotal: Object.keys(blacklist || {}).length,
      officialQueue: summarizeQueue(queue),
      batchTasks: Object.keys(batchTasks || {}).length
    }
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await updateSettings({});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    switch (type) {
      case MESSAGE_TYPES.getState:
        return await getState();
      case MESSAGE_TYPES.upsertUsers:
        return await upsertUsers(payload.users || [], payload.source, payload.meta);
      case MESSAGE_TYPES.removeUser:
        return await removeUser(payload.token);
      case MESSAGE_TYPES.updateSettings:
        return await updateSettings(payload.settings || {});
      case MESSAGE_TYPES.enqueueOfficialBlocks:
        return await enqueueOfficialBlocks(payload.users || [], payload.source);
      case MESSAGE_TYPES.enqueuePendingOfficialBlocks:
        return await enqueuePendingOfficialBlocks(payload.source);
      case MESSAGE_TYPES.getOfficialQueue:
        return {
          queue: await getOfficialQueue()
        };
      case MESSAGE_TYPES.markOfficialResult:
        return await markOfficialResult(payload);
      case MESSAGE_TYPES.getBatchTasks:
        return {
          tasks: await getBatchTasks()
        };
      case MESSAGE_TYPES.updateBatchTask:
        return await updateBatchTask(payload.id, payload.patch || {});
      case MESSAGE_TYPES.clearBatchTask:
        return await clearBatchTask(payload.id);
      case MESSAGE_TYPES.appendAuditLog:
        return await appendAuditLog(payload.entry || {});
      case MESSAGE_TYPES.clearAuditLog:
        return await clearAuditLog();
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : String(error) }));
  return true;
});
