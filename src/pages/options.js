(function optionsPage() {
  "use strict";

  const {
    MESSAGE_TYPES,
    BLOCK_SOURCE,
    DEFAULT_SETTINGS,
    extractProfile,
    uniqueUsers
  } = globalThis.ZLB;

  const ZHIHU_MEMBER_HASH_RE = /^[0-9a-f]{32}$/i;

  const controls = {
    displayMode: document.getElementById("displayMode"),
    badgeText: document.getElementById("badgeText"),
    collectVotersDelayMs: document.getElementById("collectVotersDelayMs"),
    filterSyncDelayMs: document.getElementById("filterSyncDelayMs"),
    officialBlockEnabled: document.getElementById("officialBlockEnabled"),
    officialBlockMinDelayMs: document.getElementById("officialBlockMinDelayMs"),
    officialBlockMaxDelayMs: document.getElementById("officialBlockMaxDelayMs"),
    debugLoggingEnabled: document.getElementById("debugLoggingEnabled")
  };
  const status = document.getElementById("status");
  const list = document.getElementById("list");
  const total = document.getElementById("blacklistTotal");
  const search = document.getElementById("search");
  const auditTotal = document.getElementById("auditTotal");
  const auditLog = document.getElementById("auditLog");

  let currentState = null;

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || "Extension message failed"));
          return;
        }
        resolve(response.data);
      });
    });
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function queryTabs(query) {
    return new Promise((resolve) => {
      chrome.tabs.query(query, resolve);
    });
  }

  function createTab(createProperties) {
    return new Promise((resolve) => {
      chrome.tabs.create(createProperties, resolve);
    });
  }

  function getTab(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.get(tabId, (tab) => {
        const lastError = chrome.runtime.lastError;
        resolve(lastError ? null : tab);
      });
    });
  }

  function reloadTab(tabId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.reload(tabId, {}, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function injectContentScripts(tabId) {
    return new Promise((resolve, reject) => {
      if (!chrome.scripting || !chrome.scripting.executeScript) {
        reject(new Error("当前扩展缺少 chrome.scripting 权限，请在扩展管理页重新加载本扩展"));
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content/zhihu-hook-injector.js", "src/common.js", "src/content/zhihu-content.js"]
      }, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isZhihuTab(tab) {
    return Boolean(tab && tab.id && tab.url && tab.url.startsWith("https://www.zhihu.com/"));
  }

  async function waitForZhihuTabReady(tabId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await getTab(tabId);
      if (!latest) {
        throw new Error("知乎标签页已关闭");
      }
      if (isZhihuTab(latest) && latest.status === "complete") {
        return latest;
      }
      await delay(300);
    }
    throw new Error(`等待知乎标签页加载超时：${latest && latest.url ? latest.url : "unknown"}`);
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (!response || response.ok === false) {
          reject(new Error((response && response.error) || "知乎页面未响应"));
          return;
        }
        resolve(response.data || response);
      });
    });
  }

  async function pingContentScript(tabId) {
    const response = await sendTabMessage(tabId, { type: "ZLB_PING" });
    if (!response || response.extension !== "zhihu-local-blocker") {
      throw new Error("知乎页面内容脚本版本不匹配");
    }
    return response;
  }

  async function ensureContentScript(tab, options) {
    const target = await waitForZhihuTabReady(tab.id, options && options.timeoutMs ? options.timeoutMs : 15000);
    let lastError = null;
    try {
      return await pingContentScript(target.id);
    } catch (error) {
      lastError = error;
    }
    try {
      await injectContentScripts(target.id);
      await delay(300);
      return await pingContentScript(target.id);
    } catch (error) {
      lastError = error;
    }
    if (options && options.reloadOnMiss) {
      await reloadTab(target.id);
      await waitForZhihuTabReady(target.id, 15000);
      await delay(500);
      try {
        return await pingContentScript(target.id);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("知乎页面未响应");
  }

  async function runQueueInTab(tab, created, options) {
    await ensureContentScript(tab, options);
    const response = await sendTabMessage(tab.id, { type: "ZLB_RUN_OFFICIAL_QUEUE" });
    await send(MESSAGE_TYPES.appendAuditLog, {
      entry: {
        level: "info",
        action: "options-official-run",
        message: "设置页触发官方同步成功",
        tabId: tab.id,
        created
      }
    });
    return { ran: true, tabId: tab.id, created, result: response.result || response };
  }

  async function logOfficialRunFailure(tab, created, error, action) {
    await send(MESSAGE_TYPES.appendAuditLog, {
      entry: {
        level: "warn",
        action,
        message: error ? error.message : "知乎页面未响应",
        tabId: tab && tab.id,
        created
      }
    });
  }

  async function runOfficialQueueInZhihuTab() {
    const activeTabs = await queryTabs({ active: true, currentWindow: true });
    const activeZhihu = activeTabs.find(isZhihuTab);
    const zhihuTabs = await queryTabs({ url: "https://www.zhihu.com/*" });
    const candidates = [];
    if (activeZhihu) {
      candidates.push(activeZhihu);
    }
    for (const tab of zhihuTabs) {
      if (isZhihuTab(tab) && !candidates.some((candidate) => candidate.id === tab.id)) {
        candidates.push(tab);
      }
    }

    let lastError = null;
    for (const tab of candidates.slice(0, 3)) {
      try {
        return await runQueueInTab(tab, false, { timeoutMs: 8000, reloadOnMiss: false });
      } catch (error) {
        lastError = error;
        await logOfficialRunFailure(tab, false, error, "options-official-existing-tab-miss");
      }
    }

    const target = await createTab({ url: "https://www.zhihu.com/", active: true });
    try {
      return await runQueueInTab(target, true, { timeoutMs: 20000, reloadOnMiss: true });
    } catch (error) {
      lastError = error;
      await send(MESSAGE_TYPES.appendAuditLog, {
        entry: {
          level: "error",
          action: "options-official-run-failed",
          message: lastError ? lastError.message : "知乎页面未响应",
          tabId: target && target.id,
          created: true
        }
      });
      return { ran: false, reason: lastError ? lastError.message : "知乎页面未响应" };
    }
  }

  function formToSettings() {
    return {
      displayMode: controls.displayMode.value,
      badgeText: controls.badgeText.value || DEFAULT_SETTINGS.badgeText,
      collectVotersDelayMs: Number(controls.collectVotersDelayMs.value),
      filterSyncDelayMs: Number(controls.filterSyncDelayMs.value),
      officialBlockEnabled: controls.officialBlockEnabled.checked,
      officialBlockMinDelayMs: Number(controls.officialBlockMinDelayMs.value),
      officialBlockMaxDelayMs: Number(controls.officialBlockMaxDelayMs.value),
      debugLoggingEnabled: controls.debugLoggingEnabled.checked
    };
  }

  function fillSettings(settings) {
    controls.displayMode.value = settings.displayMode;
    controls.badgeText.value = settings.badgeText;
    controls.collectVotersDelayMs.value = settings.collectVotersDelayMs;
    controls.filterSyncDelayMs.value = settings.filterSyncDelayMs;
    controls.officialBlockEnabled.checked = Boolean(settings.officialBlockEnabled);
    controls.officialBlockMinDelayMs.value = settings.officialBlockMinDelayMs;
    controls.officialBlockMaxDelayMs.value = settings.officialBlockMaxDelayMs;
    controls.debugLoggingEnabled.checked = Boolean(settings.debugLoggingEnabled);
  }

  async function saveSettings() {
    await send(MESSAGE_TYPES.updateSettings, { settings: formToSettings() });
    setStatus("设置已保存");
  }

  function renderList() {
    if (!currentState) {
      return;
    }
    const query = search.value.trim().toLowerCase();
    const entries = Object.values(currentState.blacklist || {})
      .filter((entry) => {
        const haystack = `${entry.displayName || ""} ${entry.token || ""} ${entry.profileUrl || ""}`.toLowerCase();
        return !query || haystack.includes(query);
      })
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 300);
    total.textContent = `${Object.keys(currentState.blacklist || {}).length} 人`;
    list.innerHTML = "";
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "entry";
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = entry.displayName || entry.urlToken || entry.token;
      const meta = document.createElement("span");
      meta.textContent = `${entry.token} · ${entry.officialBlockStatus || "not-queued"} · ${(entry.sources || []).join(", ")}`;
      info.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "entry-actions";
      const queueOfficial = document.createElement("button");
      queueOfficial.type = "button";
      queueOfficial.textContent = "官方同步";
      queueOfficial.title = "将该用户加入知乎官方拉黑同步队列，需要在知乎页面中继续执行队列";
      queueOfficial.addEventListener("click", async () => {
        queueOfficial.disabled = true;
        try {
          setStatus("已加入官方同步队列，正在寻找或打开知乎页面执行...");
          await send(MESSAGE_TYPES.enqueueOfficialBlocks, {
            users: [entry],
            source: "manual-official"
          });
          await send(MESSAGE_TYPES.appendAuditLog, {
            entry: {
              level: "info",
              action: "options-official-enqueue",
              message: `设置页加入官方同步队列：${entry.displayName || entry.urlToken || entry.token}`,
              token: entry.token,
              profileUrl: entry.profileUrl
            }
          });
          let runResult = null;
          try {
            runResult = await runOfficialQueueInZhihuTab();
          } catch (error) {
            runResult = { ran: false, reason: error.message };
          }
          if (runResult.ran) {
            const result = runResult.result || {};
            setStatus(`已加入并尝试执行官方同步：成功 ${result.succeeded || 0}，失败 ${result.failed || 0}`);
          } else {
            setStatus(`已加入官方同步队列；${runResult.reason}，请打开知乎页面后在扩展弹窗点“继续官方拉黑同步”`);
          }
          await refresh();
        } catch (error) {
          setStatus(`官方同步失败：${error.message}`);
        } finally {
          queueOfficial.disabled = false;
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.addEventListener("click", async () => {
        await send(MESSAGE_TYPES.removeUser, { token: entry.token });
        await refresh();
      });
      actions.append(queueOfficial, remove);
      row.append(info, actions);
      list.appendChild(row);
    }
  }

  function auditLogText() {
    return JSON.stringify(currentState && currentState.auditLog ? currentState.auditLog : [], null, 2);
  }

  function renderAuditLog() {
    const entries = currentState && currentState.auditLog ? currentState.auditLog : [];
    auditTotal.textContent = `${entries.length} 条`;
    auditLog.textContent = entries.slice(0, 80).map((entry) => {
      const level = entry.level || "info";
      const action = entry.action || "unknown";
      const message = entry.message || "";
      return `[${entry.at || ""}] [${level}] [${action}] ${message}\n${JSON.stringify(entry, null, 2)}`;
    }).join("\n\n");
  }

  async function refresh() {
    currentState = await send(MESSAGE_TYPES.getState);
    fillSettings(currentState.settings);
    renderList();
    renderAuditLog();
  }

  function profileUrlFor(kind, urlToken) {
    return kind && urlToken ? `https://www.zhihu.com/${kind}/${urlToken}` : "";
  }

  function canonicalToken(kind, urlToken) {
    return kind && urlToken ? `${kind}:${String(urlToken)}` : "";
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

  function collectIdentityAliases(base, candidate) {
    if (!base || !candidate || typeof candidate !== "object") {
      return base;
    }
    const aliases = new Set((base.meta && base.meta.aliasTokens) || []);
    const aliasUrlTokens = new Set((base.meta && base.meta.aliasUrlTokens) || []);
    const profileUrls = new Set((base.meta && base.meta.profileUrls) || []);
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
      displayName: candidate.name || candidate.fullname || candidate.display_name || base.displayName,
      meta: {
        ...((base && base.meta) || {}),
        zhihuId: rawId && ZHIHU_MEMBER_HASH_RE.test(String(rawId)) ? String(rawId) : ((base.meta && base.meta.zhihuId) || ""),
        aliasTokens: Array.from(aliases).filter(Boolean),
        aliasUrlTokens: Array.from(aliasUrlTokens).filter(Boolean),
        profileUrls: Array.from(profileUrls).filter(Boolean)
      }
    };
  }

  async function resolveZhihuUserProfile(user) {
    if (!user || user.kind === "org") {
      return user;
    }
    try {
      const response = await fetch(`https://www.zhihu.com/api/v4/members/${encodeURIComponent(user.urlToken)}`, {
        credentials: "include",
        headers: { "accept": "application/json, text/plain, */*" }
      });
      if (!response.ok) {
        return user;
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
      const primary = profile ? userWithPrimaryProfile(user, profile) : user;
      return collectIdentityAliases(primary, json);
    } catch (_error) {
      return user;
    }
  }

  async function addManualProfiles() {
    const raw = document.getElementById("manualProfiles").value;
    const users = uniqueUsers(raw.split(/\r?\n/).map((line) => {
      const profile = extractProfile(line.trim());
      if (!profile) {
        return null;
      }
      return {
        token: profile.token,
        urlToken: profile.urlToken,
        kind: profile.kind,
        profileUrl: profile.profileUrl,
        displayName: profile.urlToken,
        sources: [BLOCK_SOURCE.manual]
      };
    }).filter(Boolean));
    if (!users.length) {
      setStatus("没有识别到有效知乎用户主页");
      return;
    }
    setStatus(`正在解析 ${users.length} 个用户主页...`);
    const resolvedUsers = uniqueUsers(await Promise.all(users.map(resolveZhihuUserProfile)));
    await send(MESSAGE_TYPES.upsertUsers, {
      users: resolvedUsers,
      source: BLOCK_SOURCE.manual
    });
    document.getElementById("manualProfiles").value = "";
    setStatus(`已加入 ${resolvedUsers.length} 人`);
    await refresh();
  }

  async function syncAllOfficial() {
    const button = document.getElementById("syncAllOfficial");
    button.disabled = true;
    try {
      setStatus("正在检查本地名单并补齐官方同步队列...");
      await refresh();
      let enqueueResult = null;
      try {
        enqueueResult = await send(MESSAGE_TYPES.enqueuePendingOfficialBlocks, {
          source: "options-sync-all"
        });
      } catch (error) {
        if (!/Unknown message type: ZLB_ENQUEUE_PENDING_OFFICIAL_BLOCKS/.test(error.message)) {
          throw error;
        }
        const pendingUsers = Object.values((currentState && currentState.blacklist) || {}).filter((entry) => {
          const kind = entry.kind || (String(entry.token || "").startsWith("people:") ? "people" : "");
          const sources = Array.isArray(entry.sources) ? entry.sources : [];
          return entry && kind === "people" && entry.officialBlockStatus !== "succeeded" && !sources.includes(BLOCK_SOURCE.settingsFilter);
        });
        enqueueResult = await send(MESSAGE_TYPES.enqueueOfficialBlocks, {
          users: pendingUsers,
          source: "options-sync-all"
        });
      }
      const queued = enqueueResult.queued || 0;
      const skipped = enqueueResult.skipped || 0;
      const cleanedOfficialImported = enqueueResult.removedQueuedOfficialImported || 0;
      const cleanedUnavailable = enqueueResult.removedQueuedOfficialUnavailable || enqueueResult.markedOfficialUnavailable || 0;
      const cleanupText = cleanedOfficialImported || cleanedUnavailable
        ? `；已清理已官方导入 ${cleanedOfficialImported} 人、不可官方同步 ${cleanedUnavailable} 人`
        : "";
      setStatus(`已补入官方队列 ${queued} 人，跳过 ${skipped} 人${cleanupText}；正在打开知乎页面执行...`);
      let runResult = null;
      try {
        runResult = await runOfficialQueueInZhihuTab();
      } catch (error) {
        runResult = { ran: false, reason: error.message };
      }
      if (runResult.ran) {
        const result = runResult.result || {};
        setStatus(`全部官方同步已尝试执行：成功 ${result.succeeded || 0}，失败 ${result.failed || 0}，跳过 ${result.skipped || 0}${result.stopped ? "，已暂停等待验证/风控解除" : ""}`);
      } else {
        setStatus(`官方队列已补齐；${runResult.reason}。打开知乎页面完成验证后可再次点击补全全部官方同步。`);
      }
      await refresh();
    } catch (error) {
      setStatus(`补全官方同步失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(currentState.blacklist || {}, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `zhihu-local-blocker-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyAuditLog() {
    await navigator.clipboard.writeText(auditLogText());
    setStatus("诊断日志已复制");
  }

  function exportAuditLog() {
    downloadJson(`zhihu-local-blocker-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, currentState.auditLog || []);
    setStatus("诊断日志已导出到下载目录");
  }

  async function clearAuditLog() {
    await send(MESSAGE_TYPES.clearAuditLog);
    setStatus("诊断日志已清空");
    await refresh();
  }

  async function importJson(file) {
    const text = await file.text();
    const json = JSON.parse(text);
    const users = Object.values(json).map((entry) => ({
      ...entry,
      sources: [...(entry.sources || []), BLOCK_SOURCE.import]
    }));
    await send(MESSAGE_TYPES.upsertUsers, {
      users,
      source: BLOCK_SOURCE.import
    });
    setStatus(`已导入 ${users.length} 条记录`);
    await refresh();
  }

  for (const [name, element] of Object.entries(controls)) {
    element.addEventListener("change", () => saveSettings()
      .then(() => name === "debugLoggingEnabled" ? refresh() : null)
      .catch((error) => setStatus(error.message)));
  }
  controls.badgeText.addEventListener("input", () => saveSettings().catch((error) => setStatus(error.message)));
  search.addEventListener("input", renderList);
  document.getElementById("addManual").addEventListener("click", () => addManualProfiles().catch((error) => setStatus(error.message)));
  document.getElementById("syncAllOfficial").addEventListener("click", () => syncAllOfficial().catch((error) => setStatus(error.message)));
  document.getElementById("exportJson").addEventListener("click", exportJson);
  document.getElementById("copyAuditLog").addEventListener("click", () => copyAuditLog().catch((error) => setStatus(error.message)));
  document.getElementById("exportAuditLog").addEventListener("click", exportAuditLog);
  document.getElementById("clearAuditLog").addEventListener("click", () => clearAuditLog().catch((error) => setStatus(error.message)));
  document.getElementById("importJson").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) {
      importJson(file).catch((error) => setStatus(error.message));
    }
  });

  refresh().catch((error) => setStatus(error.message));
})();
