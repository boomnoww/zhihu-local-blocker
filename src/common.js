(function attachZhihuLocalBlockerCommon(global) {
  "use strict";

  const KEY_PREFIX = "zlb:";

  const STORAGE_KEYS = Object.freeze({
    blacklist: `${KEY_PREFIX}blacklist`,
    settings: `${KEY_PREFIX}settings`,
    officialQueue: `${KEY_PREFIX}officialQueue`,
    batchTasks: `${KEY_PREFIX}batchTasks`,
    auditLog: `${KEY_PREFIX}auditLog`
  });

  const MESSAGE_TYPES = Object.freeze({
    getState: "ZLB_GET_STATE",
    upsertUsers: "ZLB_UPSERT_USERS",
    removeUser: "ZLB_REMOVE_USER",
    updateSettings: "ZLB_UPDATE_SETTINGS",
    enqueueOfficialBlocks: "ZLB_ENQUEUE_OFFICIAL_BLOCKS",
    enqueuePendingOfficialBlocks: "ZLB_ENQUEUE_PENDING_OFFICIAL_BLOCKS",
    getOfficialQueue: "ZLB_GET_OFFICIAL_QUEUE",
    markOfficialResult: "ZLB_MARK_OFFICIAL_RESULT",
    getBatchTasks: "ZLB_GET_BATCH_TASKS",
    updateBatchTask: "ZLB_UPDATE_BATCH_TASK",
    clearBatchTask: "ZLB_CLEAR_BATCH_TASK",
    appendAuditLog: "ZLB_APPEND_AUDIT_LOG",
    clearAuditLog: "ZLB_CLEAR_AUDIT_LOG"
  });

  const DEFAULT_SETTINGS = Object.freeze({
    displayMode: "fold",
    badgeText: "已拉黑",
    autoApplyDisplayRules: true,
    collectVotersDelayMs: 900,
    collectVotersMaxIdleRounds: 8,
    collectVotersMaxRounds: 1500,
    filterSyncDelayMs: 900,
    filterSyncMaxPages: 500,
    filterSyncPageSize: 20,
    officialBlockEnabled: true,
    officialBlockMinDelayMs: 5000,
    officialBlockMaxDelayMs: 10000,
    officialBlockStopAfterFailures: 1,
    officialBlockEndpointTemplate: "/api/v4/members/{token}/actions/block",
    debugLoggingEnabled: false
  });

  const DEBUG_AUDIT_ACTIONS = new Set([
    "answer-action-banner",
    "answer-action-scan",
    "answer-voters-api-page",
    "answer-voters-api-request",
    "answer-voters-api-response",
    "comment-api-payload",
    "comment-click-diagnostic",
    "comment-hook-ready",
    "comment-scan",
    "comment-scan-diagnostic",
    "comment-surface-diagnostic",
    "filter-sync-api-page",
    "filter-sync-api-request",
    "filter-sync-api-response",
    "official-block-request",
    "official-block-response"
  ]);

  const BLOCK_SOURCE = Object.freeze({
    manual: "manual",
    settingsFilter: "settings-filter",
    answerAuthor: "answer-author",
    answerVoter: "answer-voter",
    commentAuthor: "comment-author",
    import: "import"
  });

  function nowIso() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, numeric));
  }

  function randomBetween(min, max) {
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return Math.floor(low + Math.random() * (high - low + 1));
  }

  function isDebugAuditEntry(entry) {
    if (!entry) {
      return false;
    }
    return entry.debug === true || entry.level === "debug" || DEBUG_AUDIT_ACTIONS.has(String(entry.action || ""));
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeProfileUrl(href) {
    if (!href) {
      return "";
    }
    try {
      const url = new URL(href, "https://www.zhihu.com");
      if (url.hostname !== "www.zhihu.com" && url.hostname !== "zhihu.com") {
        return "";
      }
      const match = url.pathname.match(/^\/(people|org)\/([^/?#]+)/);
      if (!match) {
        return "";
      }
      return `https://www.zhihu.com/${match[1]}/${decodeURIComponent(match[2])}`;
    } catch (_error) {
      return "";
    }
  }

  function extractProfile(urlOrHref) {
    const profileUrl = normalizeProfileUrl(urlOrHref);
    if (!profileUrl) {
      return null;
    }
    const parsed = new URL(profileUrl);
    const match = parsed.pathname.match(/^\/(people|org)\/([^/?#]+)/);
    if (!match) {
      return null;
    }
    const kind = match[1];
    const slug = decodeURIComponent(match[2]);
    return {
      token: `${kind}:${slug}`,
      urlToken: slug,
      kind,
      profileUrl
    };
  }

  function userFromAnchor(anchor, source) {
    if (!anchor || !anchor.getAttribute) {
      return null;
    }
    const profile = extractProfile(anchor.getAttribute("href") || anchor.href || "");
    if (!profile) {
      return null;
    }
    const displayName = normalizeText(anchor.getAttribute("title") || anchor.textContent || anchor.getAttribute("aria-label"));
    return {
      token: profile.token,
      urlToken: profile.urlToken,
      kind: profile.kind,
      profileUrl: profile.profileUrl,
      displayName,
      sources: source ? [source] : []
    };
  }

  function tokenAliasesFromUserLike(user) {
    const aliases = new Set();
    if (!user) {
      return [];
    }
    if (user.token) {
      aliases.add(user.token);
    }
    if (user.kind && user.urlToken) {
      aliases.add(`${user.kind}:${user.urlToken}`);
    }
    const profile = extractProfile(user.profileUrl || "");
    if (profile) {
      aliases.add(profile.token);
    }
    const meta = user.meta || {};
    for (const alias of meta.aliasTokens || []) {
      aliases.add(alias);
    }
    for (const urlToken of meta.aliasUrlTokens || []) {
      aliases.add(`${user.kind || "people"}:${urlToken}`);
    }
    for (const profileUrl of meta.profileUrls || []) {
      const aliasProfile = extractProfile(profileUrl || "");
      if (aliasProfile) {
        aliases.add(aliasProfile.token);
      }
    }
    return Array.from(aliases).filter(Boolean);
  }

  function mergeArrayValues(...values) {
    return Array.from(new Set(values.flat().filter(Boolean)));
  }

  function uniqueUsers(users) {
    const map = new Map();
    for (const user of users || []) {
      if (!user || !user.token) {
        continue;
      }
      const previous = map.get(user.token) || {};
      map.set(user.token, {
        ...previous,
        ...user,
        sources: Array.from(new Set([...(previous.sources || []), ...(user.sources || [])]))
      });
    }
    return Array.from(map.values());
  }

  function parseZhihuCount(text) {
    const value = normalizeText(text);
    const match = value.match(/([\d,.]+)\s*(万|千|k|K)?/);
    if (!match) {
      return null;
    }
    const base = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) {
      return null;
    }
    const unit = match[2];
    if (unit === "万") {
      return Math.floor(base * 10000);
    }
    if (unit === "千" || unit === "k" || unit === "K") {
      return Math.floor(base * 1000);
    }
    return Math.floor(base);
  }

  function readCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function buildEntry(existing, user, source, meta) {
    const at = nowIso();
    const sources = new Set([...(existing && existing.sources ? existing.sources : []), ...(user.sources || [])]);
    if (source) {
      sources.add(source);
    }
    const alreadyOfficialBlocked = sources.has(BLOCK_SOURCE.settingsFilter);
    const existingMeta = (existing && existing.meta) || {};
    const userMeta = (user && user.meta) || {};
    const patchMeta = meta || {};
    const mergedMeta = {
      ...existingMeta,
      ...userMeta,
      ...patchMeta,
      aliasTokens: mergeArrayValues(
        tokenAliasesFromUserLike(existing),
        tokenAliasesFromUserLike(user),
        existingMeta.aliasTokens || [],
        userMeta.aliasTokens || [],
        patchMeta.aliasTokens || []
      ),
      aliasUrlTokens: mergeArrayValues(existingMeta.aliasUrlTokens || [], userMeta.aliasUrlTokens || [], patchMeta.aliasUrlTokens || []),
      profileUrls: mergeArrayValues(
        existing && existing.profileUrl ? [existing.profileUrl] : [],
        user && user.profileUrl ? [user.profileUrl] : [],
        existingMeta.profileUrls || [],
        userMeta.profileUrls || [],
        patchMeta.profileUrls || []
      )
    };
    return {
      token: user.token,
      urlToken: user.urlToken || (existing && existing.urlToken) || "",
      kind: user.kind || (existing && existing.kind) || "people",
      profileUrl: user.profileUrl || (existing && existing.profileUrl) || "",
      displayName: user.displayName || (existing && existing.displayName) || "",
      sources: Array.from(sources),
      note: user.note || (existing && existing.note) || "",
      officialBlockStatus: alreadyOfficialBlocked ? "succeeded" : (existing && existing.officialBlockStatus) || "not-queued",
      officialBlockError: alreadyOfficialBlocked ? "" : (existing && existing.officialBlockError) || "",
      createdAt: (existing && existing.createdAt) || at,
      updatedAt: at,
      lastSeenAt: at,
      meta: mergedMeta
    };
  }

  global.ZLB = Object.freeze({
    STORAGE_KEYS,
    MESSAGE_TYPES,
    DEFAULT_SETTINGS,
    BLOCK_SOURCE,
    nowIso,
    sleep,
    clampNumber,
    randomBetween,
    normalizeText,
    normalizeProfileUrl,
    extractProfile,
    userFromAnchor,
    tokenAliasesFromUserLike,
    uniqueUsers,
    parseZhihuCount,
    readCookie,
    isDebugAuditEntry,
    buildEntry
  });
})(globalThis);
