(function zhihuLocalBlockerContent() {
  "use strict";

  if (globalThis.__ZLB_CONTENT_LOADED__) {
    return;
  }
  globalThis.__ZLB_CONTENT_LOADED__ = true;

  const {
    MESSAGE_TYPES,
    BLOCK_SOURCE,
    DEFAULT_SETTINGS,
    sleep,
    clampNumber,
    randomBetween,
    normalizeText,
    userFromAnchor,
    uniqueUsers,
    parseZhihuCount,
    extractProfile,
    readCookie,
    isDebugAuditEntry
  } = globalThis.ZLB;

  const ZHIHU_MEMBER_HASH_RE = /^[0-9a-f]{32}$/i;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    blacklist: {},
    taskRunning: false,
    taskQueue: [],
    renderVersion: 0,
    lastAnswerActionCount: -1,
    lastCommentScanSignature: "",
    lastCommentDiagnosticSignature: "",
    lastCommentSurfaceSignature: "",
    lastCommentClickDiagnosticAt: 0,
    lastPageHookReadySignature: "",
    blockedCommentHints: new Map(),
    commentHintVersion: 0,
    blockedTokenAliases: new Map(),
    userResolveQueue: new Set(),
    queuedTaskKeys: new Set(),
    runningTaskKey: "",
    extensionContextInvalidated: false,
    extensionContextReloadTimer: 0,
    panel: null,
    panelLog: null,
    observer: null
  };

  function profileUrlFor(kind, urlToken) {
    return kind && urlToken ? `https://www.zhihu.com/${kind}/${urlToken}` : "";
  }

  function canonicalToken(kind, urlToken) {
    return kind && urlToken ? `${kind}:${String(urlToken)}` : "";
  }

  function isExtensionContextInvalidated(error) {
    if (error && error.zlbExtensionContextInvalidated) {
      return true;
    }
    return /Extension context invalidated|context invalidated|cannot access a chrome|chrome runtime is not available/i.test(String(error && error.message ? error.message : error || ""));
  }

  function extensionContextError() {
    const error = new Error("扩展刚刚重载，当前知乎页面里的旧脚本已失效；页面将自动刷新后继续使用新版扩展。");
    error.zlbExtensionContextInvalidated = true;
    return error;
  }

  function handleExtensionContextInvalidated() {
    if (state.extensionContextInvalidated) {
      return;
    }
    state.extensionContextInvalidated = true;
    state.taskRunning = false;
    state.runningTaskKey = "";
    state.taskQueue = [];
    state.queuedTaskKeys.clear();
    appendPanelLog("检测到扩展刚刚重载，当前知乎页面里的旧脚本已失效；将自动刷新页面以载入新版扩展。", {
      level: "warn",
      action: "extension-context-invalidated"
    });
    window.clearTimeout(state.extensionContextReloadTimer);
    state.extensionContextReloadTimer = window.setTimeout(() => {
      location.reload();
    }, 1500);
  }

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      if (state.extensionContextInvalidated) {
        reject(extensionContextError());
        return;
      }
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          try {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              if (isExtensionContextInvalidated(lastError)) {
                handleExtensionContextInvalidated();
                reject(extensionContextError());
                return;
              }
              reject(new Error(lastError.message));
              return;
            }
            if (!response || !response.ok) {
              reject(new Error((response && response.error) || "Extension message failed"));
              return;
            }
            resolve(response.data);
          } catch (callbackError) {
            if (isExtensionContextInvalidated(callbackError)) {
              handleExtensionContextInvalidated();
              reject(extensionContextError());
              return;
            }
            reject(callbackError);
          }
        });
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          handleExtensionContextInvalidated();
          reject(extensionContextError());
          return;
        }
        reject(error);
      }
    });
  }

  async function refreshState() {
    const next = await send(MESSAGE_TYPES.getState);
    state.settings = next.settings || { ...DEFAULT_SETTINGS };
    state.blacklist = next.blacklist || {};
    rebuildBlockedAliasIndex();
    state.renderVersion += 1;
    return next;
  }

  function isBlockedToken(token) {
    return Boolean(resolveBlockedEntryByToken(token));
  }

  function addBlockedAlias(aliasToken, entryToken) {
    if (aliasToken && entryToken) {
      state.blockedTokenAliases.set(String(aliasToken), entryToken);
    }
  }

  function aliasTokensFromEntry(entry) {
    const tokens = new Set();
    if (!entry || !entry.token) {
      return [];
    }
    tokens.add(entry.token);
    tokens.add(canonicalToken(entry.kind || "people", entry.urlToken));
    const profile = extractProfile(entry.profileUrl || "");
    if (profile) {
      tokens.add(profile.token);
    }
    const meta = entry.meta || {};
    for (const alias of meta.aliasTokens || []) {
      tokens.add(alias);
    }
    for (const profileUrl of meta.profileUrls || []) {
      const aliasProfile = extractProfile(profileUrl || "");
      if (aliasProfile) {
        tokens.add(aliasProfile.token);
      }
    }
    for (const urlToken of meta.aliasUrlTokens || []) {
      tokens.add(canonicalToken(entry.kind || "people", urlToken));
    }
    for (const id of [meta.zhihuId, meta.memberId, meta.id]) {
      if (id && ZHIHU_MEMBER_HASH_RE.test(String(id))) {
        tokens.add(canonicalToken("people", id));
      }
    }
    return Array.from(tokens).filter(Boolean);
  }

  function rebuildBlockedAliasIndex() {
    state.blockedTokenAliases = new Map();
    for (const entry of Object.values(state.blacklist || {})) {
      if (!entry || !entry.token) {
        continue;
      }
      for (const aliasToken of aliasTokensFromEntry(entry)) {
        addBlockedAlias(aliasToken, entry.token);
      }
    }
  }

  function resolveBlockedEntryByToken(token) {
    if (!token) {
      return null;
    }
    const canonical = state.blockedTokenAliases.get(String(token)) || String(token);
    return state.blacklist[canonical] || null;
  }

  function resolveBlockedEntryForUser(user) {
    if (!user) {
      return null;
    }
    const direct = resolveBlockedEntryByToken(user.token);
    if (direct) {
      return direct;
    }
    for (const aliasToken of aliasTokensFromEntry(user)) {
      const entry = resolveBlockedEntryByToken(aliasToken);
      if (entry) {
        return entry;
      }
    }
    return null;
  }

  function isInternalPeopleUser(user) {
    if (!user || (user.kind && user.kind !== "people")) {
      return false;
    }
    const match = String(user.token || "").match(/^people:(.+)$/);
    return Boolean(ZHIHU_MEMBER_HASH_RE.test(String(user.urlToken || "")) || (match && ZHIHU_MEMBER_HASH_RE.test(match[1])));
  }

  function allProfileAnchors(root) {
    return Array.from((root || document).querySelectorAll('a[href*="/people/"], a[href*="/org/"]'));
  }

  function collectIdentityAliases(base, candidate) {
    if (!base || !candidate || typeof candidate !== "object") {
      return base;
    }
    const aliases = new Set((base.meta && base.meta.aliasTokens) || []);
    const aliasUrlTokens = new Set((base.meta && base.meta.aliasUrlTokens) || []);
    const profileUrls = new Set((base.meta && base.meta.profileUrls) || []);
    const addProfile = (value) => {
      const profile = extractProfile(value || "");
      if (!profile) {
        return null;
      }
      aliases.add(profile.token);
      aliasUrlTokens.add(profile.urlToken);
      profileUrls.add(profile.profileUrl);
      return profile;
    };
    addProfile(base.profileUrl);
    addProfile(candidate.url || candidate.profile_url || candidate.profileUrl || candidate.resource_url);
    const kind = candidate.type === "organization" || candidate.is_org ? "org" : (base.kind || "people");
    const rawUrlToken = candidate.url_token || candidate.urlToken;
    if (rawUrlToken) {
      aliases.add(canonicalToken(kind, rawUrlToken));
      aliasUrlTokens.add(String(rawUrlToken));
      profileUrls.add(profileUrlFor(kind, rawUrlToken));
    }
    const rawId = candidate.id || candidate.member_id || candidate.memberId || candidate.uid;
    if (rawId && ZHIHU_MEMBER_HASH_RE.test(String(rawId))) {
      aliases.add(canonicalToken("people", rawId));
    }
    return {
      ...base,
      displayName: base.displayName || candidate.name || candidate.fullname || candidate.display_name || "",
      meta: {
        ...((base && base.meta) || {}),
        zhihuId: rawId && ZHIHU_MEMBER_HASH_RE.test(String(rawId)) ? String(rawId) : ((base.meta && base.meta.zhihuId) || ""),
        aliasTokens: Array.from(aliases).filter(Boolean),
        aliasUrlTokens: Array.from(aliasUrlTokens).filter(Boolean),
        profileUrls: Array.from(profileUrls).filter(Boolean)
      }
    };
  }

  function userWithPrimaryProfile(user, profile) {
    if (!user || !profile) {
      return user;
    }
    const aliases = new Set((user.meta && user.meta.aliasTokens) || []);
    aliases.add(user.token);
    aliases.add(profile.token);
    const aliasUrlTokens = new Set((user.meta && user.meta.aliasUrlTokens) || []);
    if (user.urlToken) {
      aliasUrlTokens.add(user.urlToken);
    }
    aliasUrlTokens.add(profile.urlToken);
    const profileUrls = new Set((user.meta && user.meta.profileUrls) || []);
    if (user.profileUrl) {
      profileUrls.add(user.profileUrl);
    }
    profileUrls.add(profile.profileUrl);
    return {
      ...user,
      token: profile.token,
      urlToken: profile.urlToken,
      kind: profile.kind,
      profileUrl: profile.profileUrl,
      meta: {
        ...((user && user.meta) || {}),
        aliasTokens: Array.from(aliases).filter(Boolean),
        aliasUrlTokens: Array.from(aliasUrlTokens).filter(Boolean),
        profileUrls: Array.from(profileUrls).filter(Boolean)
      }
    };
  }

  function parseUserFromProfileHtml(html, originalUser, finalUrl) {
    if (!html) {
      return null;
    }
    const profile = extractProfile(finalUrl || "");
    let next = profile ? userWithPrimaryProfile(originalUser, profile) : originalUser;
    const idMatch = String(html).match(/"id"\s*:\s*"([0-9a-f]{32})"/i);
    const tokenMatch = String(html).match(/"urlToken"\s*:\s*"([^"]+)"/) || String(html).match(/"url_token"\s*:\s*"([^"]+)"/);
    const nameMatch = String(html).match(/"name"\s*:\s*"([^"]{1,120})"/);
    if (tokenMatch && tokenMatch[1]) {
      next = userWithPrimaryProfile(next, {
        token: canonicalToken("people", tokenMatch[1]),
        urlToken: tokenMatch[1],
        kind: "people",
        profileUrl: profileUrlFor("people", tokenMatch[1])
      });
    }
    return collectIdentityAliases(next, {
      id: idMatch && idMatch[1],
      url_token: tokenMatch && tokenMatch[1],
      name: nameMatch && nameMatch[1]
    });
  }

  async function resolveZhihuUserProfile(user) {
    if (!user || user.kind === "org") {
      return user;
    }
    let resolved = user;
    const tryApiTokens = Array.from(new Set([user.urlToken, user.token && String(user.token).replace(/^people:/, "")].filter(Boolean)));
    for (const token of tryApiTokens) {
      if (!token || /[/?#]/.test(String(token))) {
        continue;
      }
      try {
        const response = await fetch(`https://www.zhihu.com/api/v4/members/${encodeURIComponent(token)}`, {
          credentials: "include",
          headers: { "accept": "application/json, text/plain, */*" }
        });
        if (!response.ok) {
          continue;
        }
        const json = await response.json();
        const apiUrlToken = json.url_token || json.urlToken;
        const apiKind = json.type === "organization" || json.is_org ? "org" : "people";
        const profile = extractProfile(json.url || json.profile_url || json.profileUrl || "") || (apiUrlToken ? {
          token: canonicalToken(apiKind, apiUrlToken),
          urlToken: String(apiUrlToken),
          kind: apiKind,
          profileUrl: profileUrlFor(apiKind, apiUrlToken)
        } : null);
        if (profile) {
          resolved = userWithPrimaryProfile(resolved, profile);
        }
        return collectIdentityAliases(resolved, json);
      } catch (_error) {
        // Fall through to the profile page resolver.
      }
    }
    if (!resolved.profileUrl) {
      return resolved;
    }
    try {
      const response = await fetch(resolved.profileUrl, {
        credentials: "include",
        headers: { "accept": "text/html,application/xhtml+xml" }
      });
      if (!response.ok) {
        return resolved;
      }
      const finalProfile = extractProfile(response.url || "");
      if (finalProfile) {
        resolved = userWithPrimaryProfile(resolved, finalProfile);
      }
      const html = await response.text();
      return parseUserFromProfileHtml(html, resolved, response.url);
    } catch (_error) {
      return resolved;
    }
  }

  function maybeResolveUnmatchedUser(user, source) {
    if (!isInternalPeopleUser(user) || state.userResolveQueue.has(user.token)) {
      return;
    }
    state.userResolveQueue.add(user.token);
    resolveZhihuUserProfile(user)
      .then(async (resolvedUser) => {
        state.userResolveQueue.delete(user.token);
        if (!resolvedUser || !resolvedUser.token || resolvedUser.token === user.token) {
          return;
        }
        if (!resolveBlockedEntryForUser(resolvedUser)) {
          return;
        }
        await send(MESSAGE_TYPES.upsertUsers, {
          users: [resolvedUser],
          source,
          meta: { pageUrl: location.href, reason: "identity-alias-refresh" }
        });
        await refreshState();
        scheduleApply();
      })
      .catch(() => {
        state.userResolveQueue.delete(user.token);
      });
  }

  function injectPageHook() {
    if (document.documentElement.dataset.zlbPageHookInjected === "1") {
      requestPageHookReplay();
      return;
    }
    document.documentElement.dataset.zlbPageHookInjected = "1";
    const script = document.createElement("script");
    try {
      script.src = chrome.runtime.getURL("src/content/zhihu-page-hook.js");
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        delete document.documentElement.dataset.zlbPageHookInjected;
        handleExtensionContextInvalidated();
        return;
      }
      throw error;
    }
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
    requestPageHookReplay();
  }

  function requestPageHookReplay() {
    for (const delay of [0, 250, 1000]) {
      window.setTimeout(() => {
        window.postMessage({
          type: "ZLB_CONTENT_COMMENT_LISTENER_READY",
          at: Date.now()
        }, location.origin);
      }, delay);
    }
  }

  function createButton(text, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.className = className || "zlb-inline-button";
    return button;
  }

  function ensurePanel(title) {
    if (state.panel) {
      state.panel.querySelector(".zlb-panel-title").textContent = title || "知乎本地屏蔽助手";
      return state.panel;
    }
    const panel = document.createElement("div");
    panel.className = "zlb-panel";
    panel.innerHTML = [
      '<div class="zlb-panel-header">',
      '<span class="zlb-panel-title"></span>',
      '<button type="button" class="zlb-panel-close" aria-label="关闭">×</button>',
      "</div>",
      '<div class="zlb-panel-body">',
      '<div class="zlb-panel-status"></div>',
      '<div class="zlb-panel-log"></div>',
      "</div>"
    ].join("");
    panel.querySelector(".zlb-panel-title").textContent = title || "知乎本地屏蔽助手";
    panel.querySelector(".zlb-panel-close").addEventListener("click", () => panel.remove());
    document.documentElement.appendChild(panel);
    state.panel = panel;
    state.panelLog = panel.querySelector(".zlb-panel-log");
    return panel;
  }

  function setPanelStatus(rows) {
    const panel = ensurePanel();
    const status = panel.querySelector(".zlb-panel-status");
    status.innerHTML = "";
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "zlb-panel-row";
      const left = document.createElement("span");
      left.textContent = label;
      const right = document.createElement("strong");
      right.textContent = value;
      row.append(left, right);
      status.appendChild(row);
    }
  }

  function appendAuditLog(entry) {
    if (state.extensionContextInvalidated) {
      return;
    }
    if (isDebugAuditEntry(entry) && !state.settings.debugLoggingEnabled) {
      return;
    }
    send(MESSAGE_TYPES.appendAuditLog, {
      entry: {
        level: "info",
        pageUrl: location.href,
        ...entry
      }
    }).catch((error) => {
      console.warn("[Zhihu Local Blocker] audit log failed", error);
    });
  }

  function appendPanelLog(text, entry) {
    ensurePanel();
    const line = document.createElement("div");
    line.textContent = text;
    state.panelLog.prepend(line);
    appendAuditLog({
      action: "panel",
      message: text,
      ...(entry || {})
    });
  }

  function runNextQueuedTask() {
    if (state.taskRunning || !state.taskQueue.length) {
      return;
    }
    const next = state.taskQueue.shift();
    if (next.key) {
      state.queuedTaskKeys.delete(next.key);
    }
    appendPanelLog(`开始队列任务：${next.label}`, {
      action: "task-dequeue",
      label: next.label,
      remaining: state.taskQueue.length
    });
    queueOrRunTask(next.label, next.run, next.key).catch((error) => {
      if (isExtensionContextInvalidated(error)) {
        return;
      }
      appendPanelLog(`队列任务启动失败：${error.message}`, {
        level: "error",
        action: "task-dequeue-error",
        message: error.message
      });
    });
  }

  async function queueOrRunTask(label, run, key) {
    if (state.taskRunning) {
      if (key && (state.runningTaskKey === key || state.queuedTaskKeys.has(key))) {
        appendPanelLog(`任务已在运行或排队，跳过重复请求：${label}`, {
          action: "task-duplicate",
          label,
          key
        });
        return { queued: false, duplicate: true };
      }
      if (key) {
        state.queuedTaskKeys.add(key);
      }
      state.taskQueue.push({ label, run, key });
      ensurePanel("任务队列");
      setPanelStatus([
        ["当前任务", "运行中"],
        ["排队任务", String(state.taskQueue.length)]
      ]);
      appendPanelLog(`任务已加入队列：${label}`, {
        action: "task-queue",
        label,
        queueLength: state.taskQueue.length
      });
      return { queued: true };
    }
    state.taskRunning = true;
    state.runningTaskKey = key || "";
    ensurePanel(label);
    try {
      return await run();
    } finally {
      state.taskRunning = false;
      state.runningTaskKey = "";
      window.setTimeout(runNextQueuedTask, 0);
    }
  }

  function insertBadge(anchor, entry) {
    if (!anchor || anchor.dataset.zlbBadgeApplied === "1") {
      return;
    }
    const nearbyText = normalizeText((anchor.parentElement && anchor.parentElement.textContent) || "");
    if (/已拉黑|已屏蔽/.test(nearbyText)) {
      anchor.dataset.zlbBadgeApplied = "1";
      return;
    }
    anchor.dataset.zlbBadgeApplied = "1";
    const badge = document.createElement("span");
    badge.className = "zlb-badge";
    badge.textContent = state.settings.badgeText || "已拉黑";
    badge.title = entry && entry.displayName ? `本地黑名单：${entry.displayName}` : "本地黑名单";
    anchor.insertAdjacentElement("afterend", badge);
  }

  function isBeforeFirstCommentContent(container, element) {
    const content = container && container.querySelector && container.querySelector(COMMENT_CONTENT_SELECTOR);
    if (!content) {
      return true;
    }
    if (!element || content.contains(element)) {
      return false;
    }
    if (!element.compareDocumentPosition) {
      return true;
    }
    return Boolean(element.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function nodeText(element) {
    return normalizeText(element && (element.textContent || element.getAttribute("title") || element.getAttribute("aria-label")) || "");
  }

  function anchorVisibleText(anchor) {
    return nodeText(anchor);
  }

  function isInCommentSurface(node) {
    return Boolean(node && node.closest && node.closest(COMMENT_SURFACE_SELECTOR));
  }

  function scoreCommentAuthorAnchor(container, anchor, index) {
    const text = anchorVisibleText(anchor);
    let score = 0;
    if (text) {
      score += 60;
    }
    if (anchor.matches(".UserLink-link, [class*='UserLink']")) {
      score += 18;
    }
    const className = String(anchor.getAttribute("class") || "");
    const nearby = normalizeText((anchor.parentElement && anchor.parentElement.textContent) || "");
    if (/avatar|Avatar/i.test(className) || anchor.closest('[class*="avatar"], [class*="Avatar"]')) {
      score -= 18;
    }
    if (anchor.closest(".zlb-blocked-banner, .zlb-answer-action-wrap, .ContentItem-actions")) {
      score -= 80;
    }
    if (/回复|回复了|回应|›|>|：/.test(nearby) && !nearby.startsWith(text)) {
      score -= 48;
    }
    const prefix = textBeforeFirstCommentContent(container);
    if (text && prefix) {
      const firstIndex = prefix.indexOf(text);
      if (firstIndex >= 0) {
        score += Math.max(0, 40 - firstIndex);
      }
      const replyMatch = prefix.match(new RegExp(`(?:回复|›|>)\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      if (replyMatch) {
        score -= 80;
      }
    }
    return score - index;
  }

  function getCommentAuthorAnchor(container) {
    if (!container || !container.querySelectorAll) {
      return null;
    }
    const anchors = Array.from(container.querySelectorAll('a[href*="/people/"], a[href*="/org/"]'))
      .filter((anchor) => {
        if (!isBeforeFirstCommentContent(container, anchor)) {
          return false;
        }
        return Boolean(userFromAnchor(anchor, BLOCK_SOURCE.commentAuthor));
      });
    return anchors
      .map((anchor, index) => ({ anchor, score: scoreCommentAuthorAnchor(container, anchor, index) }))
      .sort((a, b) => b.score - a.score)[0]?.anchor || null;
  }

  function getAnswerAuthorAnchor(container) {
    if (!container || !container.querySelectorAll) {
      return null;
    }
    const roots = Array.from(container.querySelectorAll([
      ".AuthorInfo",
      ".ContentItem-meta",
      ".AnswerItem-authorInfo",
      ".AnswerAuthor-user",
      '[class*="AuthorInfo"]'
    ].join(", "))).filter((root) => !root.closest(".RichContent, .ContentItem-actions, .Comments-container"));
    const fromRoots = roots.flatMap((root) => allProfileAnchors(root));
    const candidates = fromRoots.filter((anchor) => {
      if (anchor.closest(".RichContent, .ContentItem-actions, .Comments-container, .zlb-blocked-banner")) {
        return false;
      }
      return Boolean(userFromAnchor(anchor, BLOCK_SOURCE.answerAuthor));
    });
    return candidates.find((anchor) => normalizeText(anchor.textContent || anchor.getAttribute("title") || anchor.getAttribute("aria-label"))) || candidates[0] || null;
  }

  function getPrimaryProfileAnchor(container, kind) {
    if (kind === "comment") {
      return getCommentAuthorAnchor(container);
    }
    if (kind === "answer") {
      return getAnswerAuthorAnchor(container);
    }
    const selectorGroups = {
      comment: [
        '.CommentItemV2-meta a.UserLink-link[href*="/people/"]',
        '.CommentItem-meta a.UserLink-link[href*="/people/"]',
        '[class*="Comment"] a.UserLink-link[href*="/people/"]',
        '.Comments-container a.UserLink-link[href*="/people/"]',
        '.Comments-container a.UserLink-link[href*="/org/"]',
        '.CommentItemV2-meta a[href*="/people/"]',
        '.CommentItem-meta a[href*="/people/"]',
        '.CommentItem a[href*="/people/"]',
        'a[href*="/people/"]',
        'a[href*="/org/"]'
      ],
      answer: [
        '.AuthorInfo a.UserLink-link[href*="/people/"]',
        '.AuthorInfo a.UserLink-link[href*="/org/"]',
        '.AuthorInfo [class*="name"] a[href*="/people/"]',
        '.AuthorInfo [class*="name"] a[href*="/org/"]',
        '.AuthorInfo a[href*="/people/"]',
        '.AuthorInfo a[href*="/org/"]',
        '.ContentItem-title a[href*="/people/"]',
        '.ContentItem-title a[href*="/org/"]',
        'meta[itemprop="url"] + a[href*="/people/"]'
      ]
    };
    const selectors = selectorGroups[kind] || selectorGroups.answer;
    let fallback = null;
    for (const selector of selectors) {
      const anchors = Array.from(container.querySelectorAll(selector));
      for (const anchor of anchors) {
        if (!fallback) {
          fallback = anchor;
        }
        if (normalizeText(anchor.textContent || anchor.getAttribute("title") || anchor.getAttribute("aria-label"))) {
          return anchor;
        }
      }
    }
    return fallback;
  }

  const COMMENT_CARD_SELECTOR = [
    ".CommentItemV2",
    ".CommentItem",
    '[class*="CommentItem"]',
    '[data-za-detail-view-path-module*="Comment"]',
    '[data-za-detail-view-path-module*="comment"]'
  ].join(", ");

  const COMMENT_CONTENT_SELECTOR = [
    ".CommentContent",
    '[class*="CommentContent"]'
  ].join(", ");

  const COMMENT_SURFACE_SELECTOR = [
    ".Comments-container",
    '[class*="Comments-container"]',
    '[class*="CommentsV2"]',
    '[role="dialog"]',
    '[class*="Modal"]'
  ].join(", ");

  const ANSWER_BOUNDARY_SELECTOR = [
    ".AnswerItem",
    ".ContentItem",
    '[data-zop*="answer"]',
    '[itemprop="suggestedAnswer"]',
    'div[data-za-detail-view-path-module*="Answer"]',
    'article[data-za-detail-view-path-module*="Answer"]'
  ].join(", ");

  function findAuthorNameAnchor(card, fallbackAnchor) {
    const profile = fallbackAnchor ? userFromAnchor(fallbackAnchor) : null;
    const anchors = allProfileAnchors(card)
      .filter((anchor) => {
        const user = userFromAnchor(anchor);
        return user && (!profile || user.token === profile.token);
      })
      .sort((a, b) => {
        const aText = normalizeText(a.textContent || a.getAttribute("title") || a.getAttribute("aria-label"));
        const bText = normalizeText(b.textContent || b.getAttribute("title") || b.getAttribute("aria-label"));
        return Number(Boolean(bText)) - Number(Boolean(aText));
      });
    return anchors.find((anchor) => normalizeText(anchor.textContent || anchor.getAttribute("title") || anchor.getAttribute("aria-label"))) || fallbackAnchor;
  }

  function isProbablyAnswerCard(card) {
    if (!card || card.closest(".zlb-panel, .zlb-filter-toolbar, header, nav, .AppHeader, [class*='AppHeader'], .ProfileHeader, .Profile-sideColumn")) {
      return false;
    }
    const hasAuthor = Boolean(getPrimaryProfileAnchor(card, "answer"));
    const text = normalizeText(card.textContent || "");
    const hasAnswerSignal = /人赞同|赞同了该回答|赞同了回答|添加评论|条评论|回答/.test(text) || Boolean(card.querySelector(".RichContent, .ContentItem-actions, .VoteButton"));
    return hasAuthor && hasAnswerSignal;
  }

  function isAnswerBoundary(node) {
    return Boolean(node && node.matches && node.matches(ANSWER_BOUNDARY_SELECTOR) && !node.matches(COMMENT_CARD_SELECTOR));
  }

  function hasCommentContent(node) {
    return Boolean(node && node.querySelector && (node.matches(COMMENT_CONTENT_SELECTOR) || node.querySelector(COMMENT_CONTENT_SELECTOR)));
  }

  function commentContentCount(node) {
    if (!node || !node.querySelectorAll) {
      return 0;
    }
    const contents = new Set(Array.from(node.querySelectorAll(COMMENT_CONTENT_SELECTOR)));
    if (node.matches && node.matches(COMMENT_CONTENT_SELECTOR)) {
      contents.add(node);
    }
    return contents.size;
  }

  function textBeforeFirstCommentContent(node) {
    if (!node || !node.querySelector) {
      return "";
    }
    const content = node.matches && node.matches(COMMENT_CONTENT_SELECTOR) ? node : node.querySelector(COMMENT_CONTENT_SELECTOR);
    if (!content) {
      return "";
    }
    const fullText = normalizeText(node.textContent || "");
    const contentText = normalizeText(content.textContent || "");
    if (!fullText || !contentText) {
      return "";
    }
    const index = fullText.indexOf(contentText);
    return index > 0 ? fullText.slice(0, index) : "";
  }

  function isProbablyCommentCard(card) {
    if (!card || card.closest(".zlb-panel, .zlb-filter-toolbar, header, nav, .AppHeader, [class*='AppHeader'], .ProfileHeader, .Profile-sideColumn")) {
      return false;
    }
    if (isAnswerBoundary(card)) {
      return false;
    }
    const inCommentSurface = isInCommentSurface(card);
    const isKnownCommentNode = Boolean(card.matches && card.matches(COMMENT_CARD_SELECTOR));
    if (!inCommentSurface && !isKnownCommentNode) {
      return false;
    }
    const rect = card.getBoundingClientRect ? card.getBoundingClientRect() : { height: 0, width: 0 };
    if (rect.height <= 20 || rect.height >= 1200 || rect.width <= 160) {
      return false;
    }
    const hasAuthor = Boolean(getPrimaryProfileAnchor(card, "comment"));
    const hasApiHint = Boolean(getCommentHintForContainer(card));
    const hasContent = hasCommentContent(card);
    if (!hasAuthor && !hasApiHint && !hasContent) {
      return false;
    }
    const text = normalizeText(card.textContent || "");
    const className = String(card.className || "");
    const moduleName = String(card.getAttribute && card.getAttribute("data-za-detail-view-path-module") || "");
    const hasCommentShape = hasContent || /Comment|Modal|Dialog/i.test(`${className} ${moduleName}`) || /回复|条回复|评论|赞|喜欢|小时前|昨天|发布于|查看全部评论/.test(text);
    return hasCommentShape;
  }

  function scoreCommentCandidate(node, order, hint) {
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { height: 0, width: 0 };
    const text = normalizeText(node.textContent || "");
    const className = String(node.getAttribute && node.getAttribute("class") || "");
    const moduleName = String(node.getAttribute && node.getAttribute("data-za-detail-view-path-module") || "");
    const profileCount = allProfileAnchors(node).length;
    const contentCount = commentContentCount(node);
    const authorPrefix = textBeforeFirstCommentContent(node);
    const actionCount = Array.from(node.querySelectorAll ? node.querySelectorAll("button, a, [role='button']") : [])
      .filter((element) => /回复|赞|喜欢|评论/.test(normalizeText(element.textContent || element.getAttribute("aria-label") || ""))).length;
    let score = 0;
    if (node.matches && node.matches(COMMENT_CARD_SELECTOR)) {
      score += 100;
    }
    if (hint && hint.contentKey && textSnippetKey(node.textContent || "").includes(hint.contentKey)) {
      score += 80;
    }
    if (node.querySelector && node.querySelector(COMMENT_CONTENT_SELECTOR)) {
      score += 64;
    }
    if (node.matches && node.matches(COMMENT_CONTENT_SELECTOR)) {
      score -= 28;
    }
    if (contentCount === 1) {
      score += 48;
    } else if (contentCount > 1) {
      score -= contentCount * 32;
    }
    if (authorPrefix && authorPrefix.length <= 120) {
      score += 36;
    }
    if (/Comment/i.test(`${className} ${moduleName}`)) {
      score += 40;
    }
    if (isInCommentSurface(node)) {
      score += 16;
    }
    if (profileCount <= 3) {
      score += 24;
    } else {
      score -= profileCount * 6;
    }
    if (actionCount) {
      score += 12;
    }
    if (rect.height >= 56 && rect.height <= 520) {
      score += 12;
    } else if (rect.height > 800) {
      score -= 24;
    }
    if (text.length >= 40 && text.length <= 900) {
      score += 8;
    }
    score -= order;
    return score;
  }

  function chooseCommentCandidate(candidates, hint) {
    if (!candidates.length) {
      return null;
    }
    return candidates
      .map((node, index) => ({ node, score: scoreCommentCandidate(node, index, hint) }))
      .sort((a, b) => b.score - a.score)[0].node;
  }

  function createAnswerActionGroup(card, className) {
    const group = document.createElement("span");
    group.className = className || "zlb-answer-action-wrap";
    const authorButton = createButton("拉黑答主", "zlb-answer-action");
    authorButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runAuthorBlockTask(card);
    });
    const votersButton = createButton("拉黑答主 + 赞同者", "zlb-answer-action");
    votersButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runAnswerBlockTask(card);
    });
    group.append(authorButton, votersButton);
    return group;
  }

  function mountCommentActionNearAuthor(container, authorAnchor) {
    if (!authorAnchor || authorAnchor.dataset.zlbCommentAction === "1" || (container.classList.contains("zlb-blocked-card") && container.dataset.zlbBlockKind === "comment")) {
      return false;
    }
    const user = userFromAnchor(authorAnchor, BLOCK_SOURCE.commentAuthor);
    if (!user) {
      return false;
    }
    const button = createButton("拉黑用户", "zlb-comment-action");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runUserBlockTask(user, "拉黑评论者", BLOCK_SOURCE.commentAuthor);
    });
    authorAnchor.insertAdjacentElement("afterend", button);
    authorAnchor.dataset.zlbCommentAction = "1";
    return true;
  }

  function ensureBlockedBannerAnswerActions(container, banner, kind) {
    if (kind !== "answer" || !isProbablyAnswerCard(container) || banner.querySelector(".zlb-banner-answer-actions")) {
      return;
    }
    const actions = banner.querySelector(".zlb-blocked-banner-actions");
    if (!actions) {
      return;
    }
    actions.prepend(createAnswerActionGroup(container, "zlb-banner-answer-actions"));
    appendAuditLog({
      action: "answer-action-banner",
      message: "已在折叠栏注入拉黑答主/赞同者按钮"
    });
  }

  function blockedBanner(container, entry, kind) {
    let banner = container.querySelector(":scope > .zlb-blocked-banner");
    const directBanners = Array.from(container.children).filter((child) => child.classList && child.classList.contains("zlb-blocked-banner"));
    for (const extra of directBanners.slice(1)) {
      extra.remove();
    }
    if (banner) {
      ensureBlockedBannerAnswerActions(container, banner, kind);
      return banner;
    }
    banner = document.createElement("div");
    banner.className = "zlb-blocked-banner";
    const label = document.createElement("span");
    label.textContent = `已折叠本地黑名单用户：${entry.displayName || entry.urlToken || entry.token}`;
    const actions = document.createElement("span");
    actions.className = "zlb-blocked-banner-actions";
    const toggle = createButton("展开", "zlb-inline-button");
    toggle.addEventListener("click", () => {
      const folded = container.classList.toggle("zlb-folded");
      toggle.textContent = folded ? "展开" : "折叠";
      if (folded) {
        delete container.dataset.zlbManuallyExpanded;
      } else {
        container.dataset.zlbManuallyExpanded = "1";
      }
    });
    const remove = createButton("移出本地名单", "zlb-inline-button");
    remove.addEventListener("click", async () => {
      try {
        await send(MESSAGE_TYPES.removeUser, { token: entry.token });
        await refreshState();
        clearBlockedContainer(container);
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          return;
        }
        appendPanelLog(`移出本地名单失败：${error.message}`, {
          level: "error",
          action: "remove-user-error",
          message: error.message,
          token: entry.token
        });
      }
    });
    actions.append(toggle, remove);
    banner.append(label, actions);
    container.prepend(banner);
    ensureBlockedBannerAnswerActions(container, banner, kind);
    return banner;
  }

  function applyBlockedContainer(container, entry, kind) {
    if (!entry || !entry.token) {
      return;
    }
    if (kind === "answer") {
      for (const nested of container.querySelectorAll(".zlb-blocked-card")) {
        if (nested !== container && nested.dataset.zlbBlockKind === "answer") {
          clearBlockedContainer(nested);
        }
      }
    }
    const sameBlockedTarget = container.dataset.zlbBlockKind === (kind || "") && container.dataset.zlbBlockToken === entry.token;
    if (!sameBlockedTarget) {
      delete container.dataset.zlbManuallyExpanded;
    }
    container.classList.add("zlb-blocked-card");
    container.classList.remove("zlb-mode-fold", "zlb-mode-blackout", "zlb-mode-hide");
    container.dataset.zlbBlockKind = kind || "";
    container.dataset.zlbBlockToken = entry.token;
    const mode = state.settings.displayMode || "fold";
    container.classList.add(`zlb-mode-${mode}`);
    if (mode === "fold" && container.dataset.zlbManuallyExpanded !== "1") {
      container.classList.add("zlb-folded");
    }
    if (mode !== "mark") {
      blockedBanner(container, entry, kind);
    }
  }

  function clearBlockedContainer(container) {
    container.classList.remove("zlb-blocked-card", "zlb-folded", "zlb-mode-fold", "zlb-mode-blackout", "zlb-mode-hide");
    delete container.dataset.zlbBlockKind;
    delete container.dataset.zlbBlockToken;
    delete container.dataset.zlbManuallyExpanded;
    for (const banner of Array.from(container.children).filter((child) => child.classList && child.classList.contains("zlb-blocked-banner"))) {
      banner.remove();
    }
  }

  function maybeUpdateStoredDisplayName(user, entry, source) {
    if (!user || !user.token || !entry) {
      return;
    }
    const next = normalizeText(user.displayName);
    if (!next) {
      return;
    }
    const current = normalizeText(entry.displayName);
    if (current && current !== entry.urlToken && current !== entry.token) {
      return;
    }
    if (!state.displayNameUpdates) {
      state.displayNameUpdates = new Set();
    }
    if (state.displayNameUpdates.has(entry.token)) {
      return;
    }
    state.displayNameUpdates.add(entry.token);
    state.blacklist[entry.token] = {
      ...entry,
      displayName: next
    };
    send(MESSAGE_TYPES.upsertUsers, {
      users: [{ ...user, displayName: next }],
      source,
      meta: { pageUrl: location.href, reason: "display-name-refresh" }
    }).catch(() => {});
  }

  function processOneContainer(container, kind) {
    const processedKey = kind === "comment" ? `${state.renderVersion}:${state.commentHintVersion}` : String(state.renderVersion);
    if (container.dataset.zlbProcessedAt === processedKey) {
      return;
    }
    const anchor = getPrimaryProfileAnchor(container, kind);
    const user = userFromAnchor(anchor);
    const savedEntry = resolveBlockedEntryForUser(user);
    if (user && savedEntry) {
      const entry = {
        ...savedEntry,
        displayName: (!savedEntry.displayName || savedEntry.displayName === savedEntry.urlToken) && user.displayName ? user.displayName : savedEntry.displayName
      };
      maybeUpdateStoredDisplayName(user, savedEntry, kind === "comment" ? BLOCK_SOURCE.commentAuthor : BLOCK_SOURCE.answerAuthor);
      applyBlockedContainer(container, entry, kind);
      if ((state.settings.displayMode || "fold") === "mark") {
        insertBadge(anchor, entry);
      }
    } else if (kind === "comment") {
      const hint = getCommentHintForContainer(container);
      if (!user && hint) {
        applyBlockedContainer(container, entryFromCommentHint(hint), kind);
      } else {
        if (container.classList.contains("zlb-blocked-card") && container.dataset.zlbBlockKind === "comment") {
          clearBlockedContainer(container);
        }
        maybeResolveUnmatchedUser(user, BLOCK_SOURCE.commentAuthor);
        mountCommentActionNearAuthor(container, anchor);
      }
    }
    container.dataset.zlbProcessedAt = processedKey;
  }

  function commentContainerFromContent(content) {
    if (!content || !content.matches || !content.matches(COMMENT_CONTENT_SELECTOR)) {
      return null;
    }
    let node = content;
    const candidates = [];
    for (let depth = 0; node && depth < 9; depth += 1) {
      if (node.matches && node.matches("header, nav, .AppHeader, [class*='AppHeader'], .zlb-panel, .zlb-filter-toolbar")) {
        return null;
      }
      if (isAnswerBoundary(node)) {
        break;
      }
      if (node !== content && node.matches && node.matches(COMMENT_SURFACE_SELECTOR)) {
        break;
      }
      if (isProbablyCommentCard(node)) {
        candidates.push(node);
      }
      node = node.parentElement;
    }
    return chooseCommentCandidate(candidates);
  }

  function textSnippetKey(text) {
    const withoutTags = String(text || "").replace(/<[^>]*>/g, " ");
    const textarea = document.createElement("textarea");
    textarea.innerHTML = withoutTags;
    return normalizeText(textarea.value)
      .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, "")
      .slice(0, 80);
  }

  function rememberBlockedCommentHint(comment) {
    const user = comment && comment.user;
    const entry = resolveBlockedEntryForUser(user);
    if (!user || !user.token || !entry) {
      return false;
    }
    const key = textSnippetKey(comment.content);
    if (!key && !comment.id) {
      return false;
    }
    const hintKey = comment.id || key;
    const nextHint = {
      id: comment.id || "",
      contentKey: key,
      userToken: entry.token,
      displayName: entry.displayName || user.displayName || user.urlToken || user.token,
      receivedAt: Date.now()
    };
    const previous = state.blockedCommentHints.get(hintKey);
    state.blockedCommentHints.set(hintKey, nextHint);
    if (!previous || previous.contentKey !== nextHint.contentKey || previous.userToken !== nextHint.userToken) {
      state.commentHintVersion += 1;
    }
    return true;
  }

  function pruneBlockedCommentHints() {
    const expiresBefore = Date.now() - 10 * 60 * 1000;
    for (const [key, hint] of state.blockedCommentHints) {
      if (!hint || hint.receivedAt < expiresBefore) {
        state.blockedCommentHints.delete(key);
      }
    }
  }

  function getCommentHintForContainer(container) {
    if (!state.blockedCommentHints.size) {
      return null;
    }
    pruneBlockedCommentHints();
    const textKey = textSnippetKey(container.textContent || "");
    if (!textKey) {
      return null;
    }
    for (const hint of state.blockedCommentHints.values()) {
      if (hint.contentKey && (textKey.includes(hint.contentKey) || hint.contentKey.includes(textKey.slice(0, 40)))) {
        return hint;
      }
    }
    return null;
  }

  function entryFromCommentHint(hint) {
    const entry = resolveBlockedEntryByToken(hint.userToken) || {};
    return {
      token: hint.userToken,
      urlToken: entry.urlToken || "",
      displayName: entry.displayName || hint.displayName || hint.userToken,
      ...entry
    };
  }

  function commentContainerFromAnchor(anchor) {
    const closestComment = anchor.closest(COMMENT_CARD_SELECTOR);
    if (closestComment && isProbablyCommentCard(closestComment)) {
      return closestComment;
    }
    let node = anchor;
    const candidates = [];
    for (let depth = 0; node && depth < 10; depth += 1) {
      if (node.matches && node.matches("header, nav, .AppHeader, [class*='AppHeader'], .zlb-panel, .zlb-filter-toolbar")) {
        return null;
      }
      if (isAnswerBoundary(node)) {
        break;
      }
      if (isProbablyCommentCard(node)) {
        candidates.push(node);
      }
      node = node.parentElement;
    }
    return chooseCommentCandidate(candidates);
  }

  function describeNodeForLog(node) {
    if (!node || !node.getAttribute) {
      return "";
    }
    const className = String(node.getAttribute("class") || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join(".");
    const tag = String(node.tagName || "").toLowerCase();
    const role = node.getAttribute("role");
    const module = node.getAttribute("data-za-detail-view-path-module");
    return [tag + (className ? `.${className}` : ""), role ? `role=${role}` : "", module ? `module=${module}` : ""]
      .filter(Boolean)
      .join(" ");
  }

  function collectCommentDiagnostics() {
    const anchors = allProfileAnchors(document)
      .filter((anchor) => !anchor.closest("header, nav, .AppHeader, [class*='AppHeader'], .zlb-panel, .zlb-filter-toolbar"))
      .slice(0, 20);
    return anchors.map((anchor) => {
      const chain = [];
      let node = anchor;
      for (let depth = 0; node && depth < 7; depth += 1) {
        chain.push(describeNodeForLog(node));
        if (isAnswerBoundary(node)) {
          break;
        }
        node = node.parentElement;
      }
      const nearestText = normalizeText((anchor.parentElement && anchor.parentElement.textContent) || anchor.textContent || "").slice(0, 160);
      return {
        text: normalizeText(anchor.textContent || anchor.getAttribute("title") || anchor.getAttribute("aria-label")).slice(0, 60),
        href: anchor.getAttribute("href") || "",
        nearestText,
        chain
      };
    });
  }

  function textForElement(element) {
    return normalizeText(element && (element.textContent || element.getAttribute("aria-label") || element.getAttribute("title")) || "");
  }

  function collectCommentSurfaceDiagnostics() {
    const pattern = /评论|回复|查看全部评论|查看.*评论|条评论|条回复/;
    const elements = Array.from(document.querySelectorAll("button, a, [role='button'], [role='dialog'], [class*='Modal'], [class*='Comment'], [class*='comment']"))
      .filter((element) => !element.closest(".zlb-panel, .zlb-filter-toolbar, header, nav, .AppHeader, [class*='AppHeader']"))
      .map((element) => {
        const text = textForElement(element);
        const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { width: 0, height: 0 };
        return { element, text, rect };
      })
      .filter((item) => {
        const className = String(item.element.getAttribute && item.element.getAttribute("class") || "");
        return (pattern.test(item.text) || /Comment|comment/.test(className)) && item.rect.width > 0 && item.rect.height > 0;
      })
      .slice(0, 30);
    return elements.map((item) => {
      const chain = [];
      let node = item.element;
      for (let depth = 0; node && depth < 7; depth += 1) {
        chain.push(describeNodeForLog(node));
        node = node.parentElement;
      }
      const container = item.element.matches && item.element.matches(COMMENT_CONTENT_SELECTOR)
        ? commentContainerFromContent(item.element)
        : null;
      const authorAnchor = container ? getPrimaryProfileAnchor(container, "comment") : null;
      return {
        text: item.text.slice(0, 180),
        rect: {
          width: Math.round(item.rect.width),
          height: Math.round(item.rect.height)
        },
        chain,
        commentCandidate: container ? {
          node: describeNodeForLog(container),
          textBeforeContent: textBeforeFirstCommentContent(container).slice(0, 120),
          anchorText: authorAnchor ? normalizeText(authorAnchor.textContent || authorAnchor.getAttribute("title") || authorAnchor.getAttribute("aria-label")).slice(0, 80) : "",
          anchorHref: authorAnchor ? authorAnchor.getAttribute("href") || "" : ""
        } : null
      };
    });
  }

  function logCommentSurfaceDiagnostics(reason) {
    if (!state.settings.debugLoggingEnabled) {
      return;
    }
    const diagnostics = collectCommentSurfaceDiagnostics();
    const signature = `${reason}:${location.pathname}:${diagnostics.length}:${diagnostics.slice(0, 6).map((item) => item.text).join("|")}`;
    if (!diagnostics.length || state.lastCommentSurfaceSignature === signature) {
      return;
    }
    state.lastCommentSurfaceSignature = signature;
    appendAuditLog({
      action: "comment-surface-diagnostic",
      message: `记录疑似评论入口/弹窗结构：${reason}`,
      reason,
      items: diagnostics
    });
  }

  function findCommentCards() {
    const cards = [];
    const selectors = [
      '.CommentItem, .CommentItemV2, [class*="CommentItem"]',
      '[data-za-detail-view-path-module*="Comment"]',
      '[class*="CommentContent"]',
      '[role="dialog"] [class*="Item"]',
      '[role="dialog"] [class*="Content"]',
      '[class*="Modal"] [class*="Item"]',
      '[class*="Modal"] [class*="Content"]'
    ];
    const addCard = (card) => {
      if (!card) {
        return;
      }
      if (card.matches && card.matches(COMMENT_CONTENT_SELECTOR)) {
        addCard(commentContainerFromContent(card));
        return;
      }
      const anchor = getPrimaryProfileAnchor(card, "comment");
      const normalized = anchor ? (commentContainerFromAnchor(anchor) || card) : card;
      if (normalized && isProbablyCommentCard(normalized) && !cards.includes(normalized)) {
        cards.push(normalized);
      }
    };
    for (const selector of selectors) {
      for (const card of document.querySelectorAll(selector)) {
        addCard(card);
      }
    }
    for (const content of document.querySelectorAll(COMMENT_CONTENT_SELECTOR)) {
      addCard(commentContainerFromContent(content));
    }
    for (const anchor of allProfileAnchors(document)) {
      const card = commentContainerFromAnchor(anchor);
      addCard(card);
    }
    return cards;
  }

  function containerFromBlockedCommentHint(hint) {
    if (!hint || !hint.contentKey) {
      return null;
    }
    const candidates = [];
    const elements = Array.from(document.querySelectorAll("div, li, article, section"))
      .filter((element) => !element.closest(".zlb-panel, .zlb-filter-toolbar, header, nav, .AppHeader, [class*='AppHeader']"));
    for (const element of elements) {
      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { width: 0, height: 0 };
      if (rect.width <= 160 || rect.height <= 20 || rect.height >= 1200) {
        continue;
      }
      const key = textSnippetKey(element.textContent || "");
      if (!key || (!key.includes(hint.contentKey) && !hint.contentKey.includes(key.slice(0, 40)))) {
        continue;
      }
      if (isAnswerBoundary(element)) {
        continue;
      }
      candidates.push(element);
    }
    return chooseCommentCandidate(candidates, hint);
  }

  function findHintedCommentCards(existingCards) {
    const cards = [];
    for (const hint of state.blockedCommentHints.values()) {
      const container = containerFromBlockedCommentHint(hint);
      if (container && !existingCards.includes(container) && !cards.includes(container)) {
        cards.push(container);
      }
    }
    return cards;
  }

  function processContainers() {
    if (!state.settings.autoApplyDisplayRules) {
      return;
    }
    const commentCards = findCommentCards();
    commentCards.push(...findHintedCommentCards(commentCards));
    let blockedComments = 0;
    let commentActions = 0;
    for (const container of commentCards) {
      const beforeBlocked = container.classList.contains("zlb-blocked-card");
      const beforeAction = Boolean(container.querySelector(".zlb-comment-action"));
      processOneContainer(container, "comment");
      if (!beforeBlocked && container.classList.contains("zlb-blocked-card")) {
        blockedComments += 1;
      }
      if (!beforeAction && container.querySelector(".zlb-comment-action")) {
        commentActions += 1;
      }
    }
    const commentSignature = `${commentCards.length}:${blockedComments}:${commentActions}:${state.renderVersion}`;
    if (state.lastCommentScanSignature !== commentSignature) {
      state.lastCommentScanSignature = commentSignature;
      appendAuditLog({
        action: "comment-scan",
        message: `评论扫描 ${commentCards.length} 条，折叠 ${blockedComments} 条，新增按钮 ${commentActions} 个，接口线索 ${state.blockedCommentHints.size} 条`,
        cards: commentCards.length,
        blocked: blockedComments,
        actions: commentActions,
        hints: state.blockedCommentHints.size,
        commentHintVersion: state.commentHintVersion
      });
    }
    if (state.settings.debugLoggingEnabled && !commentCards.length) {
      const diagnosticSignature = `${location.pathname}:${state.renderVersion}`;
      if (state.lastCommentDiagnosticSignature !== diagnosticSignature) {
        state.lastCommentDiagnosticSignature = diagnosticSignature;
        appendAuditLog({
          action: "comment-scan-diagnostic",
          message: "评论扫描为 0，记录页面用户链接祖先结构用于修选择器",
          anchors: collectCommentDiagnostics()
        });
      }
      logCommentSurfaceDiagnostics("scan-zero");
    }
    for (const container of findAnswerCards()) {
      processOneContainer(container, "answer");
    }
  }

  function decorateAllBlockedAnchors() {
    if ((state.settings.displayMode || "fold") !== "mark") {
      for (const badge of document.querySelectorAll(".zlb-badge")) {
        badge.remove();
      }
      for (const anchor of document.querySelectorAll("[data-zlb-badge-applied]")) {
        delete anchor.dataset.zlbBadgeApplied;
      }
      return;
    }
    for (const anchor of allProfileAnchors(document)) {
      const user = userFromAnchor(anchor);
      const entry = resolveBlockedEntryForUser(user);
      if (user && entry) {
        if (anchor.closest(".zlb-blocked-card")) {
          continue;
        }
        insertBadge(anchor, entry);
      }
    }
  }

  function suppressNativeBlockedBadges() {
    const shouldSuppress = (state.settings.displayMode || "fold") !== "mark";
    for (const element of document.querySelectorAll("[data-zlb-native-badge-hidden='1']")) {
      if (!shouldSuppress) {
        element.style.removeProperty("display");
        delete element.dataset.zlbNativeBadgeHidden;
      }
    }
    if (!shouldSuppress) {
      return;
    }
    const candidates = Array.from(document.querySelectorAll("span, div, em, i"));
    for (const element of candidates) {
      if (element.classList.contains("zlb-badge") || element.closest(".zlb-blocked-banner") || element.closest("button, [role='button']")) {
        continue;
      }
      if (normalizeText(element.textContent) !== "已拉黑") {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width > 120 || rect.height > 60) {
        continue;
      }
      element.dataset.zlbNativeBadgeHidden = "1";
      element.style.setProperty("display", "none", "important");
    }
  }

  function installCommentClickDiagnostics() {
    if (!state.settings.debugLoggingEnabled || state.commentClickDiagnosticsInstalled) {
      return;
    }
    state.commentClickDiagnosticsInstalled = true;
    document.addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("button, a, [role='button']") : null;
      if (!target || target.closest(".zlb-panel, .zlb-filter-toolbar")) {
        return;
      }
      const text = textForElement(target);
      if (!/评论|回复|查看全部评论|查看.*评论|条评论|条回复/.test(text)) {
        return;
      }
      const now = Date.now();
      if (now - state.lastCommentClickDiagnosticAt < 800) {
        return;
      }
      state.lastCommentClickDiagnosticAt = now;
      appendAuditLog({
        action: "comment-click-diagnostic",
        message: `点击疑似评论入口：${text.slice(0, 80)}`,
        text: text.slice(0, 160),
        chain: (() => {
          const chain = [];
          let node = target;
          for (let depth = 0; node && depth < 7; depth += 1) {
            chain.push(describeNodeForLog(node));
            node = node.parentElement;
          }
          return chain;
        })()
      });
      window.setTimeout(() => {
        processContainers();
        logCommentSurfaceDiagnostics("after-comment-click-500ms");
      }, 500);
      window.setTimeout(() => {
        processContainers();
        logCommentSurfaceDiagnostics("after-comment-click-1500ms");
      }, 1500);
    }, true);
  }

  function installPageHookListener() {
    if (state.pageHookListenerInstalled) {
      return;
    }
    state.pageHookListenerInstalled = true;
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) {
        return;
      }
      const data = event.data || {};
      if (data.type === "ZLB_PAGE_COMMENT_HOOK_READY") {
        const signature = `${data.installedAt}:${data.replayed}`;
        if (state.lastPageHookReadySignature !== signature) {
          state.lastPageHookReadySignature = signature;
          appendAuditLog({
            action: "comment-hook-ready",
            message: `评论接口监听已就绪，回放 ${data.replayed || 0} 组近期响应`,
            installedAt: data.installedAt || 0,
            replayed: data.replayed || 0
          });
        }
        return;
      }
      if (data.type !== "ZLB_PAGE_COMMENT_PAYLOAD" || !Array.isArray(data.comments)) {
        return;
      }
      let matched = 0;
      for (const comment of data.comments) {
        if (rememberBlockedCommentHint(comment)) {
          matched += 1;
        }
      }
      appendAuditLog({
        action: "comment-api-payload",
        message: `评论接口返回 ${data.comments.length} 条，命中本地黑名单 ${matched} 条`,
        apiUrl: data.url || "",
        total: data.comments.length,
        matched
      });
      if (matched) {
        window.setTimeout(processContainers, 0);
        window.setTimeout(processContainers, 500);
        window.setTimeout(processContainers, 1500);
      }
    });
    requestPageHookReplay();
  }

  function findAnswerCards() {
    const selectors = [
      ".AnswerItem",
      ".List-item",
      ".ContentItem",
      'div[data-za-detail-view-path-module*="Answer"]',
      'article[data-za-detail-view-path-module*="Answer"]',
      '[data-zop*="answer"]',
      '[itemprop="suggestedAnswer"]'
    ];
    const cards = [];
    for (const selector of selectors) {
      for (const card of document.querySelectorAll(selector)) {
        if (isProbablyAnswerCard(card) && !cards.includes(card)) {
          cards.push(card);
        }
      }
    }
    return cards.filter((card) => !cards.some((other) => other !== card && card.contains(other)));
  }

  function extractAnswerId(card) {
    const candidates = [
      card.getAttribute("data-zop"),
      card.getAttribute("data-za-extra-module"),
      card.getAttribute("data-za-detail-view-element_name"),
      card.getAttribute("data-za-detail-view-path-module")
    ].filter(Boolean);
    for (const raw of candidates) {
      const direct = String(raw).match(/answer[_-]?(?:id)?["':=\s]+(\d{5,})/i) || String(raw).match(/itemId["':=\s]+(\d{5,})/i);
      if (direct) {
        return direct[1];
      }
      try {
        const json = JSON.parse(raw);
        const value = json.itemId || json.answerId || json.answer_id || json.entity_id || json.entityId;
        if (value && /^\d{5,}$/.test(String(value))) {
          return String(value);
        }
      } catch (_error) {
        // Some Zhihu data attributes are not strict JSON.
      }
    }
    const linked = Array.from(card.querySelectorAll('a[href*="/answer/"], meta[itemprop="url"]'))
      .map((element) => element.getAttribute("href") || element.getAttribute("content") || "")
      .map((href) => String(href).match(/\/answer\/(\d{5,})/))
      .find(Boolean);
    return linked ? linked[1] : "";
  }

  function mountAnswerActionsNearAuthor(card, authorAnchor) {
    const mountAnchor = findAuthorNameAnchor(card, authorAnchor);
    if (!mountAnchor || mountAnchor.dataset.zlbAuthorActions === "1") {
      return false;
    }
    const group = createAnswerActionGroup(card, "zlb-answer-action-wrap zlb-author-action-wrap");
    mountAnchor.insertAdjacentElement("afterend", group);
    mountAnchor.dataset.zlbAuthorActions = "1";
    return true;
  }

  function findVoterListOpener(card) {
    const candidates = Array.from(card.querySelectorAll("button, a, [role='button']"));
    const scored = candidates
      .map((element) => ({
        element,
        text: normalizeText(element.textContent || element.getAttribute("aria-label") || "")
      }))
      .filter((item) => item.text.includes("赞同"))
      .sort((a, b) => {
        const aScore = /人赞同|赞同了|等.*赞同/.test(a.text) ? 0 : 1;
        const bScore = /人赞同|赞同了|等.*赞同/.test(b.text) ? 0 : 1;
        return aScore - bScore;
      });
    return scored.length ? scored[0].element : null;
  }

  function parseExpectedVoterCount(card) {
    const opener = findVoterListOpener(card);
    const openerCount = opener ? parseZhihuCount(opener.textContent || opener.getAttribute("aria-label")) : null;
    if (openerCount) {
      return openerCount;
    }
    const text = normalizeText(card.textContent);
    const match = text.match(/([\d,.]+\s*(?:万|千|k|K)?)\s*人赞同/);
    return match ? parseZhihuCount(match[0]) : null;
  }

  function decorateAnswerActions() {
    const cards = findAnswerCards();
    let injected = 0;
    for (const card of cards) {
      if (card.dataset.zlbAnswerAction === "1") {
        continue;
      }
      const authorAnchor = getPrimaryProfileAnchor(card, "answer");
      const author = userFromAnchor(authorAnchor, BLOCK_SOURCE.answerAuthor);
      if (!author) {
        continue;
      }
      if (card.classList.contains("zlb-blocked-card")) {
        const banner = card.querySelector(":scope > .zlb-blocked-banner");
        if (banner) {
          ensureBlockedBannerAnswerActions(card, banner, "answer");
        }
        continue;
      }
      if (mountAnswerActionsNearAuthor(card, authorAnchor)) {
        card.dataset.zlbAnswerAction = "1";
        injected += 1;
      }
    }
    if (state.lastAnswerActionCount !== cards.length) {
      state.lastAnswerActionCount = cards.length;
      appendAuditLog({
        action: "answer-action-scan",
        message: `识别回答卡片 ${cards.length} 个，本轮新增按钮 ${injected} 个`,
        cards: cards.length,
        injected
      });
    }
  }

  function cleanupLegacyAnswerActions() {
    for (const group of document.querySelectorAll(".zlb-answer-action-wrap:not(.zlb-author-action-wrap)")) {
      if (!group.closest(".zlb-blocked-banner")) {
        group.remove();
      }
    }
    for (const card of findAnswerCards()) {
      if (!card.querySelector(".zlb-author-action-wrap") && !card.classList.contains("zlb-blocked-card")) {
        delete card.dataset.zlbAnswerAction;
      }
    }
  }

  function cleanupMisplacedCommentActions() {
    for (const button of document.querySelectorAll(".zlb-comment-action")) {
      const surface = button.closest(COMMENT_SURFACE_SELECTOR);
      if (!surface) {
        const previous = button.previousElementSibling;
        if (previous && previous.dataset) {
          delete previous.dataset.zlbCommentAction;
        }
        button.remove();
        continue;
      }
      const previous = button.previousElementSibling;
      const container = previous ? commentContainerFromAnchor(previous) : null;
      const authorAnchor = container ? getPrimaryProfileAnchor(container, "comment") : null;
      if (!previous || !container || !authorAnchor || authorAnchor !== previous || authorAnchor.nextElementSibling !== button) {
        if (previous && previous.dataset) {
          delete previous.dataset.zlbCommentAction;
        }
        button.remove();
      }
    }
    for (const anchor of document.querySelectorAll("[data-zlb-comment-action]")) {
      if (!anchor.closest(COMMENT_SURFACE_SELECTOR)) {
        delete anchor.dataset.zlbCommentAction;
      }
    }
  }

  function findDialog() {
    const candidates = [
      ...document.querySelectorAll('[role="dialog"], .Modal, .Modal-wrapper, .Popover, .Popover-content')
    ];
    return candidates
      .filter((element) => element.offsetParent !== null)
      .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0] || null;
  }

  function findScrollable(root) {
    if (!root) {
      return null;
    }
    const candidates = [root, ...root.querySelectorAll("*")].filter((element) => {
      const style = getComputedStyle(element);
      const overflow = `${style.overflowY} ${style.overflow}`;
      return /(auto|scroll|overlay)/.test(overflow) && element.scrollHeight > element.clientHeight + 24;
    });
    return candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || root;
  }

  async function waitForDialogWithProfiles(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const dialog = findDialog();
      if (dialog && allProfileAnchors(dialog).length > 0) {
        return dialog;
      }
      await sleep(250);
    }
    return findDialog();
  }

  function usersFromRoot(root, source) {
    return uniqueUsers(allProfileAnchors(root).map((anchor) => userFromAnchor(anchor, source)).filter(Boolean));
  }

  function userFromApiMemberItem(item, source) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const candidate = item.member || item.user || item;
    const profile = extractProfile(candidate.url || candidate.profile_url || candidate.profileUrl || candidate.resource_url || "");
    const memberId = candidate.id || candidate.member_id || candidate.memberId || candidate.uid;
    const explicitUrlToken = candidate.url_token || candidate.urlToken || "";
    const hasPublicProfileToken = Boolean(explicitUrlToken || profile);
    const urlToken = explicitUrlToken || (profile && profile.urlToken) || (memberId && ZHIHU_MEMBER_HASH_RE.test(String(memberId)) ? String(memberId) : "");
    if (!urlToken) {
      return null;
    }
    const kind = profile ? profile.kind : (candidate.type === "organization" || candidate.is_org ? "org" : "people");
    const user = {
      token: `${kind}:${urlToken}`,
      urlToken: String(urlToken),
      kind,
      profileUrl: hasPublicProfileToken ? profileUrlFor(kind, urlToken) : "",
      displayName: candidate.name || candidate.fullname || candidate.headline || String(urlToken),
      sources: source ? [source] : []
    };
    return collectIdentityAliases(user, candidate);
  }

  function usersFromFilterPage() {
    const actionTextPattern = /移出|移除|解除|取消|屏蔽|黑名单|拉黑/;
    const anchors = allProfileAnchors(document.body);
    const users = [];
    for (const anchor of anchors) {
      let node = anchor;
      let accepted = false;
      for (let depth = 0; node && depth < 7; depth += 1) {
        const text = normalizeText(node.textContent || "");
        const isHeaderLike = node.matches && node.matches("header, nav, .AppHeader, [class*='AppHeader'], [class*='TopstoryTabs']");
        if (isHeaderLike) {
          break;
        }
        const hasAction = Array.from(node.querySelectorAll ? node.querySelectorAll("button, a, [role='button']") : [])
          .some((element) => actionTextPattern.test(normalizeText(element.textContent || element.getAttribute("aria-label") || "")));
        const looksLikeListItem = node.matches && node.matches(".List-item, [class*='List-item'], [class*='UserItem'], [class*='Member'], [class*='Filter']");
        if ((hasAction || looksLikeListItem) && actionTextPattern.test(text)) {
          accepted = true;
          break;
        }
        node = node.parentElement;
      }
      if (accepted) {
        const user = userFromAnchor(anchor, BLOCK_SOURCE.settingsFilter);
        if (user) {
          users.push(user);
        }
      }
    }
    return uniqueUsers(users);
  }

  function isVerificationStatus(status) {
    return [401, 403, 429].includes(Number(status));
  }

  function isVerificationMessage(message) {
    return /HTTP (401|403|429)|验证码|安全验证|验证|风控|captcha|verify/i.test(String(message || ""));
  }

  function verificationPauseError(message) {
    const error = new Error(message);
    error.zlbPausedForVerification = true;
    return error;
  }

  function isVerificationPause(error) {
    return Boolean(error && (error.zlbPausedForVerification || isVerificationMessage(error.message)));
  }

  function officialUnavailableError(message) {
    const error = new Error(message || "缺少可用于官方拉黑的知乎 url_token");
    error.zlbOfficialUnavailable = true;
    return error;
  }

  function isOfficialUnavailable(error) {
    return Boolean(error && error.zlbOfficialUnavailable);
  }

  function triggerVerificationRefresh(reason) {
    appendPanelLog(`检测到知乎可能需要验证，已保存进度，准备刷新页面：${reason}`, {
      level: "warn",
      action: "verification-refresh",
      reason
    });
    window.setTimeout(() => {
      location.reload();
    }, 1200);
  }

  function isLikelyVerificationPage() {
    const text = `${document.title || ""} ${normalizeText(document.body && document.body.textContent || "").slice(0, 800)}`;
    return /验证|安全|captcha|verify|风控|环境异常|登录/.test(text);
  }

  function answerBatchTaskId(answerId, author) {
    return `answer-batch:${answerId || location.pathname}:${author && author.token ? author.token : "unknown"}`;
  }

  async function getBatchTask(id) {
    try {
      const result = await send(MESSAGE_TYPES.getBatchTasks);
      const tasks = result.tasks || {};
      return id ? tasks[id] || null : null;
    } catch (error) {
      if (/Unknown message type: ZLB_GET_BATCH_TASKS/.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async function getBatchTasks() {
    try {
      const result = await send(MESSAGE_TYPES.getBatchTasks);
      return result.tasks || {};
    } catch (error) {
      if (/Unknown message type: ZLB_GET_BATCH_TASKS/.test(error.message)) {
        return {};
      }
      throw error;
    }
  }

  async function updateBatchTask(id, patch) {
    try {
      return await send(MESSAGE_TYPES.updateBatchTask, {
        id,
        patch
      });
    } catch (error) {
      if (/Unknown message type: ZLB_UPDATE_BATCH_TASK/.test(error.message)) {
        return { unsupported: true, task: { id, ...(patch || {}) } };
      }
      throw error;
    }
  }

  async function clearBatchTask(id) {
    try {
      return await send(MESSAGE_TYPES.clearBatchTask, { id });
    } catch (error) {
      if (/Unknown message type: ZLB_CLEAR_BATCH_TASK/.test(error.message)) {
        return { unsupported: true, cleared: false };
      }
      throw error;
    }
  }

  function findAnswerCardById(answerId) {
    if (!answerId) {
      return null;
    }
    return findAnswerCards().find((card) => extractAnswerId(card) === String(answerId)) || null;
  }

  function samePageAsTask(task) {
    if (!task) {
      return false;
    }
    if (task.answerId && location.href.includes(`/answer/${task.answerId}`)) {
      return true;
    }
    if (!task.pageUrl) {
      return false;
    }
    try {
      const url = new URL(task.pageUrl);
      return url.pathname === location.pathname;
    } catch (_error) {
      return false;
    }
  }

  async function saveCollectedVoters(users, meta) {
    const unique = uniqueUsers(users);
    if (!unique.length) {
      return;
    }
    await send(MESSAGE_TYPES.upsertUsers, {
      users: unique,
      source: BLOCK_SOURCE.answerVoter,
      meta: { pageUrl: location.href, ...(meta || {}) }
    });
    await send(MESSAGE_TYPES.enqueueOfficialBlocks, {
      users: unique,
      source: "answer-batch-voters"
    });
  }

  async function enqueuePendingOfficialBlocksFallback(users, source) {
    try {
      return await send(MESSAGE_TYPES.enqueuePendingOfficialBlocks, { source });
    } catch (error) {
      if (!/Unknown message type: ZLB_ENQUEUE_PENDING_OFFICIAL_BLOCKS/.test(error.message)) {
        throw error;
      }
      return await send(MESSAGE_TYPES.enqueueOfficialBlocks, {
        users: uniqueUsers(users || []),
        source
      });
    }
  }

  async function collectVotersFromDialog(expectedCount, batchTask) {
    const dialog = await waitForDialogWithProfiles(6000);
    if (!dialog) {
      throw new Error("没有找到赞同者弹窗。请确认当前回答能打开赞同者列表。");
    }
    const scroller = findScrollable(dialog);
    const seen = new Map();
    let idleRounds = 0;
    let rounds = 0;
    const delayMs = clampNumber(state.settings.collectVotersDelayMs, 200, 5000, DEFAULT_SETTINGS.collectVotersDelayMs);
    const maxIdleRounds = clampNumber(state.settings.collectVotersMaxIdleRounds, 2, 30, DEFAULT_SETTINGS.collectVotersMaxIdleRounds);
    const maxRounds = clampNumber(state.settings.collectVotersMaxRounds, 20, 10000, DEFAULT_SETTINGS.collectVotersMaxRounds);
    while (rounds < maxRounds && idleRounds < maxIdleRounds) {
      rounds += 1;
      const users = usersFromRoot(dialog, BLOCK_SOURCE.answerVoter);
      const before = seen.size;
      for (const user of users) {
        seen.set(user.token, user);
      }
      const collected = Array.from(seen.values());
      if (seen.size > before) {
        idleRounds = 0;
        await saveCollectedVoters(collected, { method: "dialog" });
        await refreshState();
        if (batchTask && batchTask.id) {
          await updateBatchTask(batchTask.id, {
            status: "running-dialog",
            collectedCount: seen.size,
            lastError: "",
            pageUrl: location.href
          });
        }
        setPanelStatus([
          ["本地名单新增/识别", String(seen.size)],
          ["目标赞同者数", expectedCount ? String(expectedCount) : "未知"],
          ["滚动轮次", String(rounds)]
        ]);
        appendPanelLog(`已识别赞同者 ${seen.size} 人`);
      } else {
        idleRounds += 1;
      }
      if (expectedCount && seen.size >= expectedCount) {
        break;
      }
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: Math.max(480, scroller.clientHeight || 480), bubbles: true }));
      scroller.scrollBy(0, Math.max(480, Math.floor((scroller.clientHeight || 600) * 0.85)));
      await sleep(delayMs);
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 6) {
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    }
    return Array.from(seen.values());
  }

  async function collectVotersViaApi(card, expectedCount, batchTask) {
    const answerId = extractAnswerId(card);
    if (!answerId) {
      throw new Error("没有识别到回答 ID，无法使用赞同者接口");
    }
    const seen = new Map();
    let offset = Math.max(0, Number(batchTask && batchTask.nextOffset || 0) || 0);
    let rounds = 0;
    const limit = 20;
    const delayMs = clampNumber(state.settings.collectVotersDelayMs, 200, 5000, DEFAULT_SETTINGS.collectVotersDelayMs);
    const maxRounds = clampNumber(state.settings.collectVotersMaxRounds, 20, 10000, DEFAULT_SETTINGS.collectVotersMaxRounds);
    if (expectedCount && offset >= expectedCount) {
      appendPanelLog(`赞同者断点 offset ${offset} 已达到页面显示数量，跳过继续抓取`, {
        action: "answer-voters-api-resume-complete",
        answerId,
        offset,
        expectedCount
      });
      return [];
    }
    while (rounds < maxRounds) {
      rounds += 1;
      const apiUrl = `/api/v4/answers/${answerId}/voters?offset=${offset}&limit=${limit}`;
      appendAuditLog({
        action: "answer-voters-api-request",
        message: `请求回答赞同者接口 answer=${answerId} offset=${offset}`,
        answerId,
        apiUrl
      });
      const response = await fetch(apiUrl, {
        credentials: "include",
        headers: { "accept": "application/json, text/plain, */*" }
      });
      appendAuditLog({
        action: "answer-voters-api-response",
        message: `回答赞同者接口响应 HTTP ${response.status}`,
        answerId,
        apiUrl,
        status: response.status,
        ok: response.ok
      });
      if (!response.ok) {
        if (batchTask && batchTask.id && isVerificationStatus(response.status)) {
          await updateBatchTask(batchTask.id, {
            status: "paused-verification",
            pauseReason: `回答赞同者接口 HTTP ${response.status}`,
            pausedAt: new Date().toISOString(),
            nextOffset: offset,
            answerId,
            pageUrl: location.href,
            expectedCount: expectedCount || 0
          });
          triggerVerificationRefresh(`回答赞同者接口 HTTP ${response.status}`);
          throw verificationPauseError(`回答赞同者接口 HTTP ${response.status}，已暂停等待验证`);
        }
        throw new Error(`回答赞同者接口 HTTP ${response.status}`);
      }
      const json = await response.json();
      const data = Array.isArray(json.data) ? json.data : [];
      const users = uniqueUsers(data.map((item) => userFromApiMemberItem(item, BLOCK_SOURCE.answerVoter)).filter(Boolean));
      for (const user of users) {
        seen.set(user.token, user);
      }
      await saveCollectedVoters(users, { method: "api", answerId, offset });
      await refreshState();
      const nextOffset = offset + (data.length || limit);
      if (batchTask && batchTask.id) {
        await updateBatchTask(batchTask.id, {
          status: "running-api",
          method: "api",
          answerId,
          pageUrl: location.href,
          expectedCount: expectedCount || 0,
          nextOffset,
          collectedCount: Math.max(Number(batchTask.collectedCount || 0), nextOffset),
          lastError: ""
        });
      }
      setPanelStatus([
        ["赞同者接口轮次", String(rounds)],
        ["本轮识别赞同者", String(seen.size)],
        ["下次续传 offset", String(nextOffset)],
        ["目标赞同者数", expectedCount ? String(expectedCount) : "未知"]
      ]);
      appendPanelLog(`赞同者接口第 ${rounds} 轮识别 ${users.length} 人，累计 ${seen.size} 人`, {
        action: "answer-voters-api-page",
        answerId,
        rounds,
        users: users.length,
        totalSeen: seen.size
      });
      const paging = json.paging || {};
      const totals = Number(paging.totals);
      if (paging.is_end || !data.length || (expectedCount && nextOffset >= expectedCount) || (Number.isFinite(totals) && nextOffset >= totals)) {
        return Array.from(seen.values());
      }
      offset = nextOffset;
      await sleep(delayMs);
    }
    return Array.from(seen.values());
  }

  async function collectVoters(card, expectedCount, batchTask) {
    try {
      const users = await collectVotersViaApi(card, expectedCount, batchTask);
      if (users.length) {
        return users;
      }
      appendPanelLog("赞同者接口没有返回用户，改用弹窗滚动", {
        level: "warn",
        action: "answer-voters-api-empty"
      });
    } catch (error) {
      if (isVerificationPause(error)) {
        throw error;
      }
      if (isExtensionContextInvalidated(error)) {
        throw error;
      }
      appendPanelLog(`赞同者接口不可用，改用弹窗滚动：${error.message}`, {
        level: "warn",
        action: "answer-voters-api-fallback",
        message: error.message
      });
    }
    const opener = findVoterListOpener(card);
    if (!opener) {
      throw new Error("没有找到赞同者列表入口。");
    }
    opener.click();
    appendPanelLog("已打开赞同者列表，开始自动滚动收集");
    return await collectVotersFromDialog(expectedCount, batchTask);
  }

  async function runUserBlockTask(user, label, source) {
    if (!user || !user.token) {
      alert("没有识别到用户。");
      return;
    }
    const ok = confirm(`将用户${user.displayName ? `「${user.displayName}」` : ""}加入本地黑名单，并按设置尝试知乎官方拉黑。`);
    if (!ok) {
      return;
    }
    await queueOrRunTask(`${label}：${user.displayName || user.urlToken}`, async () => {
      try {
        const resolvedUser = await resolveZhihuUserProfile(user);
        await send(MESSAGE_TYPES.upsertUsers, {
          users: [resolvedUser],
          source,
          meta: { pageUrl: location.href }
        });
        await refreshState();
        appendPanelLog(`已将用户加入本地黑名单：${resolvedUser.displayName || resolvedUser.urlToken}`);
        processContainers();
        await send(MESSAGE_TYPES.enqueueOfficialBlocks, {
          users: [resolvedUser],
          source
        });
        if (state.settings.officialBlockEnabled) {
          await processOfficialQueue();
        } else {
          appendPanelLog("设置中已关闭官方拉黑同步，仅保留本地名单");
        }
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          return;
        }
        appendPanelLog(`${label}任务停止：${error.message}`, {
          level: "error",
          action: "user-block",
          message: error.message,
          token: user.token
        });
      }
    });
  }

  async function runAuthorBlockTask(card) {
    const author = userFromAnchor(getPrimaryProfileAnchor(card, "answer"), BLOCK_SOURCE.answerAuthor);
    if (!author) {
      alert("没有识别到该回答的答主。");
      return;
    }
    const ok = confirm(`将答主${author.displayName ? `「${author.displayName}」` : ""}加入本地黑名单，并按设置尝试知乎官方拉黑。`);
    if (!ok) {
      return;
    }
    await queueOrRunTask(`拉黑答主：${author.displayName || author.urlToken}`, async () => {
      try {
        await send(MESSAGE_TYPES.upsertUsers, {
          users: [author],
          source: BLOCK_SOURCE.answerAuthor,
          meta: { pageUrl: location.href }
        });
        await refreshState();
        appendPanelLog(`已将答主加入本地黑名单：${author.displayName || author.urlToken}`);
        processContainers();
        await send(MESSAGE_TYPES.enqueueOfficialBlocks, {
          users: [author],
          source: "answer-author"
        });
        if (state.settings.officialBlockEnabled) {
          await processOfficialQueue();
        } else {
          appendPanelLog("设置中已关闭官方拉黑同步，仅保留本地名单");
        }
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          return;
        }
        appendPanelLog(`拉黑答主任务停止：${error.message}`, {
          level: "error",
          action: "answer-author",
          message: error.message
        });
      }
    });
  }

  async function runAnswerBlockTask(card, options) {
    const runOptions = options || {};
    const author = userFromAnchor(getPrimaryProfileAnchor(card, "answer"), BLOCK_SOURCE.answerAuthor);
    if (!author) {
      alert("没有识别到该回答的答主。");
      return;
    }
    const answerId = extractAnswerId(card);
    const taskId = answerBatchTaskId(answerId, author);
    const expectedCount = parseExpectedVoterCount(card);
    const ok = runOptions.skipConfirm || confirm([
      `将先把答主${author.displayName ? `「${author.displayName}」` : ""}和该回答赞同者加入本地黑名单。`,
      expectedCount ? `页面显示赞同者约 ${expectedCount} 人。` : "未能读取准确赞同者总数，将滚动到没有新增用户为止。",
      "本地名单写入后，会尽力低速同步知乎官方拉黑；遇到限制会停止官方同步。"
    ].join("\n"));
    if (!ok) {
      return;
    }
    await queueOrRunTask(`拉黑答主 + 赞同者：${author.displayName || author.urlToken}`, async () => {
      try {
        const previousTask = await getBatchTask(taskId);
        const batchTask = {
          ...(previousTask || {}),
          id: taskId,
          type: "answer-batch",
          answerId,
          author,
          expectedCount: expectedCount || (previousTask && previousTask.expectedCount) || 0,
          pageUrl: location.href
        };
        await updateBatchTask(taskId, {
          ...batchTask,
          status: "running",
          resume: Boolean(previousTask),
          lastError: ""
        });
        await send(MESSAGE_TYPES.upsertUsers, {
          users: [author],
          source: BLOCK_SOURCE.answerAuthor,
          meta: { pageUrl: location.href }
        });
        await send(MESSAGE_TYPES.enqueueOfficialBlocks, {
          users: [author],
          source: "answer-batch-author"
        });
        await refreshState();
        appendPanelLog(previousTask ? "继续未完成批量任务，已确认答主在本地名单中" : "已将答主加入本地黑名单");
        decorateAllBlockedAnchors();
        processContainers();
        const voters = await collectVoters(card, expectedCount || batchTask.expectedCount, batchTask);
        const allUsers = uniqueUsers([author, ...voters]);
        await send(MESSAGE_TYPES.upsertUsers, {
          users: allUsers,
          source: BLOCK_SOURCE.answerVoter,
          meta: { pageUrl: location.href }
        });
        await refreshState();
        decorateAllBlockedAnchors();
        processContainers();
        appendPanelLog(`本地名单本轮处理 ${allUsers.length} 人，正在补齐官方同步队列`);
        await enqueuePendingOfficialBlocksFallback(allUsers, "answer-batch");
        if (state.settings.officialBlockEnabled) {
          await processOfficialQueue();
        } else {
          appendPanelLog("设置中已关闭官方拉黑同步，仅保留本地名单");
        }
        await clearBatchTask(taskId);
      } catch (error) {
        if (isVerificationPause(error)) {
          appendPanelLog(`批量任务已断点暂停：${error.message}`, {
            level: "warn",
            action: "answer-batch-paused",
            taskId
          });
          return { paused: true, taskId };
        }
        if (isExtensionContextInvalidated(error)) {
          return { invalidated: true, taskId };
        }
        await updateBatchTask(taskId, {
          status: "failed",
          lastError: error.message,
          failedAt: new Date().toISOString(),
          pageUrl: location.href
        }).catch(() => {});
        appendPanelLog(`任务停止：${error.message}`);
        await send(MESSAGE_TYPES.appendAuditLog, {
          entry: { level: "error", action: "answer-batch", message: error.message, pageUrl: location.href }
        });
      }
    }, taskId);
  }

  async function officialBlockUser(item) {
    const profile = item && extractProfile(item.profileUrl || "");
    const tokenMatch = item && item.token ? String(item.token).match(/^people:(.+)$/) : null;
    const urlToken = [profile && profile.kind === "people" ? profile.urlToken : "", item && item.urlToken, tokenMatch && tokenMatch[1]]
      .map((value) => String(value || ""))
      .find((value) => value && !/[/?#]/.test(value) && !ZHIHU_MEMBER_HASH_RE.test(value));
    if (!item || !urlToken) {
      throw officialUnavailableError("缺少可用于官方拉黑的知乎 url_token");
    }
    const endpoint = (state.settings.officialBlockEndpointTemplate || DEFAULT_SETTINGS.officialBlockEndpointTemplate)
      .replace("{token}", encodeURIComponent(urlToken));
    const headers = {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json"
    };
    const xsrf = readCookie("_xsrf");
    if (xsrf) {
      headers["x-xsrftoken"] = xsrf;
    }
    appendAuditLog({
      action: "official-block-request",
      message: `请求知乎官方拉黑：${item.displayName || urlToken}`,
      token: item.token,
      urlToken,
      profileUrl: item.profileUrl || "",
      endpoint,
      hasXsrf: Boolean(xsrf)
    });
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers,
      body: "{}"
    });
    appendAuditLog({
      action: "official-block-response",
      message: `知乎官方拉黑响应 HTTP ${response.status}`,
      token: item.token,
      urlToken,
      profileUrl: item.profileUrl || "",
      endpoint,
      status: response.status,
      ok: response.ok
    });
    if (response.ok || response.status === 204) {
      return;
    }
    if (response.status === 404) {
      throw officialUnavailableError("知乎官方拉黑接口返回 404，可能不是可拉黑的公开 url_token");
    }
    if ([401, 403, 405, 429].includes(response.status)) {
      throw new Error(`知乎官方拉黑接口停止：HTTP ${response.status}`);
    }
    const text = await response.text().catch(() => "");
    if (/captcha|验证码|verify|安全验证/i.test(text)) {
      throw new Error("知乎要求验证码或安全验证");
    }
    throw new Error(`知乎官方拉黑失败：HTTP ${response.status}`);
  }

  async function processOfficialQueue() {
    await refreshState();
    const queueState = await send(MESSAGE_TYPES.getOfficialQueue);
    const queue = Object.values(queueState.queue || {}).filter((item) => item.status === "queued");
    if (!queue.length) {
      appendPanelLog("官方同步队列为空");
      return { processed: 0, succeeded: 0, failed: 0, stopped: false };
    }
    const minDelay = clampNumber(state.settings.officialBlockMinDelayMs, 1000, 60000, DEFAULT_SETTINGS.officialBlockMinDelayMs);
    const maxDelay = clampNumber(state.settings.officialBlockMaxDelayMs, 1000, 120000, DEFAULT_SETTINGS.officialBlockMaxDelayMs);
    const stopAfterFailures = clampNumber(state.settings.officialBlockStopAfterFailures, 1, 10, DEFAULT_SETTINGS.officialBlockStopAfterFailures);
    let failed = 0;
    let succeeded = 0;
    let skipped = 0;
    let stopped = false;
    appendPanelLog(`官方同步队列开始：${queue.length} 人`, {
      action: "official-queue-start",
      queueLength: queue.length
    });
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      setPanelStatus([
        ["官方同步进度", `${index + 1}/${queue.length}`],
        ["当前用户", item.displayName || item.urlToken || item.token],
        ["失败次数", String(failed)]
      ]);
      try {
        await sleep(randomBetween(minDelay, maxDelay));
        await officialBlockUser(item);
        await send(MESSAGE_TYPES.markOfficialResult, {
          token: item.token,
          status: "succeeded"
        });
        succeeded += 1;
        appendPanelLog(`官方拉黑成功：${item.displayName || item.urlToken}`);
      } catch (error) {
        if (isOfficialUnavailable(error)) {
          skipped += 1;
          await send(MESSAGE_TYPES.markOfficialResult, {
            token: item.token,
            status: "unavailable",
            error: error.message
          });
          appendPanelLog(`官方同步跳过：${item.displayName || item.urlToken || item.token}（${error.message}）`);
          appendAuditLog({
            level: "warn",
            action: "official-block-unavailable",
            message: error.message,
            token: item.token,
            urlToken: item.urlToken,
            profileUrl: item.profileUrl || ""
          });
          continue;
        }
        if (isExtensionContextInvalidated(error)) {
          throw error;
        }
        failed += 1;
        await send(MESSAGE_TYPES.markOfficialResult, {
          token: item.token,
          status: "failed",
          error: error.message
        });
        appendPanelLog(`官方同步停止/失败：${error.message}`);
        appendAuditLog({
          level: "error",
          action: "official-block-error",
          message: error.message,
          token: item.token,
          urlToken: item.urlToken,
          profileUrl: item.profileUrl || ""
        });
        if (failed >= stopAfterFailures || /HTTP (401|403|405|429)|验证码|安全验证|缺少知乎用户 token/.test(error.message)) {
          if (isVerificationMessage(error.message)) {
            triggerVerificationRefresh(error.message);
          }
          stopped = true;
          break;
        }
      }
    }
    await refreshState();
    const result = {
      processed: succeeded + failed + skipped,
      succeeded,
      failed,
      skipped,
      stopped
    };
    appendPanelLog(`官方同步结束：成功 ${succeeded}，失败 ${failed}，跳过 ${skipped}`, {
      action: "official-queue-finish",
      ...result
    });
    return result;
  }

  function findNextPageButton() {
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
    return candidates.find((element) => {
      const text = normalizeText(element.textContent || element.getAttribute("aria-label") || element.title);
      const disabled = element.disabled || element.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(element.className || "");
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      const className = String(element.className || "");
      const hasRightIcon = Boolean(element.querySelector('[class*="Right"], [class*="right"], [class*="Arrow"], [class*="arrow"], svg[aria-label*="right"], svg[aria-label*="下一"]'));
      const looksLikeNext = text === "下一页" || text.includes("下一页") || text.toLowerCase() === "next" || text === ">" || text === "›" || text === "》" || /next|right|arrow/i.test(className) || hasRightIcon;
      return visible && !disabled && looksLikeNext;
    }) || null;
  }

  function userFromBlockedApiItem(item) {
    return userFromApiMemberItem(item, BLOCK_SOURCE.settingsFilter);
  }

  async function fetchBlockedUsersPage(offset, limit) {
    const apiUrl = `/api/v3/settings/blocked_users?offset=${offset}&limit=${limit}`;
    appendAuditLog({
      action: "filter-sync-api-request",
      message: `请求黑名单接口 offset=${offset} limit=${limit}`,
      apiUrl
    });
    const response = await fetch(apiUrl, {
      credentials: "include",
      headers: { "accept": "application/json, text/plain, */*" }
    });
    appendAuditLog({
      action: "filter-sync-api-response",
      message: `黑名单接口响应 HTTP ${response.status}`,
      apiUrl,
      status: response.status,
      ok: response.ok
    });
    if (!response.ok) {
      throw new Error(`黑名单接口 HTTP ${response.status}`);
    }
    return await response.json();
  }

  async function syncSettingsFilterViaApi() {
    let offset = 0;
    let rounds = 0;
    let totalSeen = 0;
    const pageSize = clampNumber(state.settings.filterSyncPageSize, 6, 100, DEFAULT_SETTINGS.filterSyncPageSize);
    const maxPages = clampNumber(state.settings.filterSyncMaxPages, 1, 2000, DEFAULT_SETTINGS.filterSyncMaxPages);
    const delayMs = clampNumber(state.settings.filterSyncDelayMs, 300, 5000, DEFAULT_SETTINGS.filterSyncDelayMs);
    while (rounds < maxPages) {
      rounds += 1;
      const json = await fetchBlockedUsersPage(offset, pageSize);
      const data = Array.isArray(json.data) ? json.data : [];
      const users = uniqueUsers(data.map(userFromBlockedApiItem).filter(Boolean));
      await send(MESSAGE_TYPES.upsertUsers, {
        users,
        source: BLOCK_SOURCE.settingsFilter,
        meta: { pageUrl: location.href, method: "api", offset, pageSize }
      });
      await refreshState();
      totalSeen += users.length;
      setPanelStatus([
        ["接口同步轮次", String(rounds)],
        ["本轮识别用户", String(users.length)],
        ["本地黑名单总数", String(Object.keys(state.blacklist).length)]
      ]);
      appendPanelLog(`接口第 ${rounds} 轮识别 ${users.length} 名用户`, {
        action: "filter-sync-api-page",
        rounds,
        users: users.length,
        offset,
        pageSize
      });
      const paging = json.paging || {};
      const totals = Number(paging.totals);
      if (paging.is_end || !data.length || (Number.isFinite(totals) && offset + data.length >= totals)) {
        return { method: "api", rounds, totalSeen };
      }
      offset += data.length || pageSize;
      await sleep(delayMs);
    }
    return { method: "api", rounds, totalSeen, stoppedByMaxPages: true };
  }

  async function syncSettingsFilterPage() {
    if (!location.pathname.startsWith("/settings/filter")) {
      alert("请先打开知乎网页端黑名单页面：https://www.zhihu.com/settings/filter");
      return;
    }
    if (state.taskRunning) {
      alert("已有任务正在运行，请等待它结束。");
      return;
    }
    state.taskRunning = true;
    ensurePanel("同步知乎黑名单到本地");
    try {
      try {
        const apiResult = await syncSettingsFilterViaApi();
        decorateAllBlockedAnchors();
        processContainers();
        appendPanelLog(`接口同步完成，累计识别 ${apiResult.totalSeen} 条记录`, {
          action: "filter-sync-api-finish",
          ...apiResult
        });
        return apiResult;
      } catch (apiError) {
        appendPanelLog(`接口同步不可用，改用页面翻页：${apiError.message}`, {
          level: "warn",
          action: "filter-sync-api-fallback",
          message: apiError.message
        });
      }
      let page = 0;
      let totalSeen = 0;
      const maxPages = clampNumber(state.settings.filterSyncMaxPages, 1, 2000, DEFAULT_SETTINGS.filterSyncMaxPages);
      const delayMs = clampNumber(state.settings.filterSyncDelayMs, 300, 5000, DEFAULT_SETTINGS.filterSyncDelayMs);
      while (page < maxPages) {
        page += 1;
        const users = usersFromFilterPage();
        await send(MESSAGE_TYPES.upsertUsers, {
          users,
          source: BLOCK_SOURCE.settingsFilter,
          meta: { pageUrl: location.href }
        });
        await refreshState();
        totalSeen += users.length;
        setPanelStatus([
          ["已扫描页数", String(page)],
          ["本页识别用户", String(users.length)],
          ["本地黑名单总数", String(Object.keys(state.blacklist).length)]
        ]);
        appendPanelLog(`第 ${page} 页识别 ${users.length} 名用户`);
        const next = findNextPageButton();
        if (!next) {
          appendPanelLog("未找到下一页，同步结束", {
            action: "filter-sync-dom-no-next",
            page,
            users: users.length
          });
          break;
        }
        next.click();
        await sleep(delayMs);
      }
      decorateAllBlockedAnchors();
      processContainers();
      const result = { method: "dom", rounds: page, totalSeen };
      appendPanelLog(`同步完成，累计扫描 ${totalSeen} 条页面记录`, {
        action: "filter-sync-dom-finish",
        ...result
      });
      return result;
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        return { method: "invalidated", error: error.message };
      }
      appendPanelLog(`同步停止：${error.message}`, {
        level: "error",
        action: "filter-sync-error",
        message: error.message
      });
      return { method: "failed", error: error.message };
    } finally {
      state.taskRunning = false;
    }
  }

  function addSettingsFilterToolbar() {
    if (!location.pathname.startsWith("/settings/filter") || document.querySelector(".zlb-filter-toolbar")) {
      return;
    }
    const toolbar = document.createElement("div");
    toolbar.className = "zlb-filter-toolbar";
    const text = document.createElement("span");
    text.textContent = "知乎本地屏蔽助手";
    const button = createButton("同步本页及后续黑名单", "zlb-inline-button");
    button.addEventListener("click", syncSettingsFilterPage);
    toolbar.append(text, button);
    const mount = document.querySelector("main") || document.body;
    mount.prepend(toolbar);
  }

  function addResumeBatchButton(task, card) {
    const panel = ensurePanel("批量任务断点续传");
    if (Array.from(panel.querySelectorAll("[data-zlb-resume-task]")).some((button) => button.dataset.zlbResumeTask === task.id)) {
      return;
    }
    const button = createButton("继续未完成批量任务", "zlb-inline-button");
    button.dataset.zlbResumeTask = task.id;
    button.addEventListener("click", () => {
      const targetCard = card || findAnswerCardById(task.answerId);
      if (!targetCard) {
        appendPanelLog("没有找到对应回答，请回到原回答页面后再继续");
        return;
      }
      runAnswerBlockTask(targetCard, { skipConfirm: true, resume: true }).catch((error) => {
        if (isExtensionContextInvalidated(error)) {
          return;
        }
        appendPanelLog(`恢复任务失败：${error.message}`, {
          level: "error",
          action: "answer-batch-resume-error",
          taskId: task.id
        });
      });
    });
    const status = panel.querySelector(".zlb-panel-status");
    if (status) {
      const row = document.createElement("div");
      row.className = "zlb-panel-row";
      const left = document.createElement("span");
      left.textContent = task.pauseReason || task.lastError || "检测到未完成任务";
      row.append(left, button);
      status.appendChild(row);
    }
  }

  async function resumePausedBatchTasksForPage(auto) {
    const tasks = await getBatchTasks();
    const candidates = Object.values(tasks || {})
      .filter((task) => task && task.type === "answer-batch" && task.status === "paused-verification" && samePageAsTask(task));
    if (!candidates.length) {
      return { resumed: false };
    }
    const task = candidates.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
    ensurePanel("批量任务断点续传");
    if (isLikelyVerificationPage()) {
      appendPanelLog("检测到未完成批量任务；请先完成知乎验证，完成后刷新或回到原回答页继续。", {
        action: "answer-batch-wait-verification",
        taskId: task.id
      });
      addResumeBatchButton(task, null);
      return { resumed: false, waitingVerification: true };
    }
    const card = findAnswerCardById(task.answerId) || findAnswerCards()[0] || null;
    addResumeBatchButton(task, card);
    if (!auto) {
      return { resumed: false, taskId: task.id };
    }
    const pausedAt = Date.parse(task.pausedAt || task.updatedAt || "");
    if (Number.isFinite(pausedAt) && Date.now() - pausedAt < 10000) {
      appendPanelLog("批量任务进度已保存，等待你完成验证后继续。", {
        action: "answer-batch-resume-cooldown",
        taskId: task.id
      });
      return { resumed: false, cooldown: true };
    }
    if (!card) {
      appendPanelLog("检测到未完成批量任务，但当前页暂时没有找到对应回答。", {
        level: "warn",
        action: "answer-batch-resume-no-card",
        taskId: task.id
      });
      return { resumed: false, noCard: true };
    }
    appendPanelLog(`检测到未完成批量任务，自动从 offset ${task.nextOffset || 0} 继续`, {
      action: "answer-batch-auto-resume",
      taskId: task.id,
      nextOffset: task.nextOffset || 0
    });
    await runAnswerBlockTask(card, { skipConfirm: true, resume: true });
    return { resumed: true, taskId: task.id };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message && message.type === "ZLB_RUN_FILTER_SYNC") {
        const result = await syncSettingsFilterPage();
        return { done: true, result };
      }
      if (message && message.type === "ZLB_RUN_OFFICIAL_QUEUE") {
        ensurePanel("官方拉黑同步队列");
        const result = await processOfficialQueue();
        return { done: true, result };
      }
      if (message && message.type === "ZLB_RESUME_BATCH_TASKS") {
        const result = await resumePausedBatchTasksForPage(false);
        return { done: true, result };
      }
      if (message && message.type === "ZLB_PING") {
        return {
          done: true,
          extension: "zhihu-local-blocker",
          version: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "0.1.0",
          pageUrl: location.href
        };
      }
      return { ignored: true };
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  function scheduleApply() {
    window.clearTimeout(scheduleApply.timer);
    scheduleApply.timer = window.setTimeout(() => {
      cleanupLegacyAnswerActions();
      cleanupMisplacedCommentActions();
      processContainers();
      decorateAnswerActions();
      decorateAllBlockedAnchors();
      suppressNativeBlockedBadges();
      addSettingsFilterToolbar();
    }, 250);
  }

  async function init() {
    await refreshState();
    installPageHookListener();
    injectPageHook();
    installCommentClickDiagnostics();
    scheduleApply();
    window.setTimeout(() => {
      resumePausedBatchTasksForPage(true).catch((error) => {
        appendAuditLog({
          level: "warn",
          action: "answer-batch-auto-resume-error",
          message: error.message
        });
      });
    }, 2500);
    state.observer = new MutationObserver(scheduleApply);
    state.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "aria-hidden", "hidden"],
      childList: true,
      subtree: true
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") {
        return;
      }
      const blacklistKey = globalThis.ZLB.STORAGE_KEYS.blacklist;
      const settingsKey = globalThis.ZLB.STORAGE_KEYS.settings;
      if (changes[blacklistKey] || changes[settingsKey]) {
        refreshState().then(scheduleApply).catch(() => {});
      }
    });
  }

  init().catch((error) => {
    console.warn("[Zhihu Local Blocker] init failed", error);
  });
})();
