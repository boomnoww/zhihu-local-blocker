(function zhihuLocalBlockerHookInjector() {
  "use strict";

  const root = document.documentElement;
  if (!root || root.dataset.zlbPageHookInjected === "1") {
    return;
  }
  root.dataset.zlbPageHookInjected = "1";

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/zhihu-page-hook.js");
  script.async = false;
  script.onload = () => script.remove();
  script.onerror = () => {
    delete root.dataset.zlbPageHookInjected;
    script.remove();
  };
  (document.head || root).appendChild(script);
})();
