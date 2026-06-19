(function popup() {
  "use strict";

  const { MESSAGE_TYPES } = globalThis.ZLB;

  const status = document.getElementById("status");
  const blacklistTotal = document.getElementById("blacklistTotal");
  const queueTotal = document.getElementById("queueTotal");

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

  async function activeTabMessage(type) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length || !tabs[0].id) {
      throw new Error("没有找到当前标签页");
    }
    return await chrome.tabs.sendMessage(tabs[0].id, { type });
  }

  function setStatus(text) {
    status.textContent = text;
  }

  async function refresh() {
    const state = await send(MESSAGE_TYPES.getState);
    blacklistTotal.textContent = String(state.summary.blacklistTotal);
    queueTotal.textContent = String(state.summary.officialQueue.queued);
  }

  document.getElementById("syncFilter").addEventListener("click", async () => {
    try {
      setStatus("已向当前页面发送同步指令");
      const response = await activeTabMessage("ZLB_RUN_FILTER_SYNC");
      const result = response && (response.data && response.data.result ? response.data.result : response.result);
      if (result) {
        setStatus(`同步完成：${result.method || "unknown"}，识别 ${result.totalSeen || 0} 条`);
      }
      await refresh();
    } catch (error) {
      setStatus(error.message);
    }
  });

  document.getElementById("runOfficialQueue").addEventListener("click", async () => {
    try {
      setStatus("已向当前知乎页面发送官方同步指令");
      const response = await activeTabMessage("ZLB_RUN_OFFICIAL_QUEUE");
      const result = response && (response.data && response.data.result ? response.data.result : response.result);
      if (result) {
        setStatus(`官方同步：成功 ${result.succeeded || 0}，失败 ${result.failed || 0}`);
      }
      await refresh();
    } catch (error) {
      setStatus(error.message);
    }
  });

  document.getElementById("resumeBatchTasks").addEventListener("click", async () => {
    try {
      setStatus("已向当前知乎页面发送断点续传指令");
      const response = await activeTabMessage("ZLB_RESUME_BATCH_TASKS");
      const result = response && (response.data && response.data.result ? response.data.result : response.result);
      if (result && result.resumed) {
        setStatus("已开始继续批量任务");
      } else if (result && result.waitingVerification) {
        setStatus("仍在等待知乎验证完成");
      } else {
        setStatus("当前页面没有可继续的批量任务");
      }
      await refresh();
    } catch (error) {
      setStatus(error.message);
    }
  });

  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  refresh().catch((error) => setStatus(error.message));
})();
