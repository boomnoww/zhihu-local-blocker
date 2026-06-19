(function zhihuLocalBlockerPageHook() {
  "use strict";

  if (window.__ZLB_PAGE_HOOK_INSTALLED__) {
    return;
  }
  window.__ZLB_PAGE_HOOK_INSTALLED__ = true;

  const MESSAGE_TYPE = "ZLB_PAGE_COMMENT_PAYLOAD";
  const READY_TYPE = "ZLB_CONTENT_COMMENT_LISTENER_READY";
  const HOOK_READY_TYPE = "ZLB_PAGE_COMMENT_HOOK_READY";
  const API_PATTERN = /\/api\/v4\/(?:comment|comment_v5|comments?|answers?\/[^/?#]+\/comments?|articles?\/[^/?#]+\/comments?)/i;
  const MEMBER_HASH_RE = /^[0-9a-f]{32}$/i;
  const installedAt = Date.now();
  const recentPayloads = [];
  if (document.documentElement) {
    document.documentElement.dataset.zlbPageHookReady = "1";
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function extractProfileRef(value) {
    if (!value) {
      return null;
    }
    const raw = String(value);
    const match = raw.match(/\/(?:people|org|members)\/([^/?#]+)/);
    if (!match) {
      return null;
    }
    return {
      kind: raw.includes("/org/") ? "org" : "people",
      urlToken: decodeURIComponent(match[1])
    };
  }

  function extractUrlToken(value) {
    const profile = extractProfileRef(value);
    return profile ? profile.urlToken : String(value || "");
  }

  function contentToText(value) {
    if (!value) {
      return "";
    }
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map(contentToText).filter(Boolean).join(" ");
    }
    if (typeof value === "object") {
      return contentToText(value.content || value.text || value.value || value.html || value.title || "");
    }
    return "";
  }

  function candidateToUser(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    let member = candidate.member || candidate.author || candidate.user || candidate.commentator || candidate;
    if (member && typeof member === "object" && member.member && typeof member.member === "object") {
      member = member.member;
    }
    if (!member || typeof member !== "object") {
      return null;
    }
    const profileFromUrl = extractProfileRef(member.url || member.profile_url || member.profileUrl || member.resource_url);
    const memberId = member.id || member.member_id || member.memberId || member.uid;
    const explicitUrlToken = member.url_token || member.urlToken || "";
    const hasPublicProfileToken = Boolean(explicitUrlToken || profileFromUrl);
    const urlToken = explicitUrlToken || (profileFromUrl && profileFromUrl.urlToken) || (memberId && MEMBER_HASH_RE.test(String(memberId)) ? String(memberId) : "");
    if (!urlToken) {
      return null;
    }
    const kind = (profileFromUrl && profileFromUrl.kind) || (member.type === "organization" || member.is_org ? "org" : "people");
    const aliases = new Set([`${kind}:${urlToken}`]);
    if (profileFromUrl) {
      aliases.add(`${profileFromUrl.kind}:${profileFromUrl.urlToken}`);
    }
    if (memberId && MEMBER_HASH_RE.test(String(memberId))) {
      aliases.add(`people:${memberId}`);
    }
    return {
      token: `${kind}:${urlToken}`,
      urlToken: String(urlToken),
      kind,
      displayName: member.name || member.fullname || member.display_name || member.headline || String(urlToken),
      profileUrl: hasPublicProfileToken ? `https://www.zhihu.com/${kind}/${urlToken}` : "",
      meta: {
        zhihuId: memberId && MEMBER_HASH_RE.test(String(memberId)) ? String(memberId) : "",
        aliasTokens: Array.from(aliases),
        aliasUrlTokens: Array.from(new Set([String(urlToken), profileFromUrl && profileFromUrl.urlToken, memberId && MEMBER_HASH_RE.test(String(memberId)) ? String(memberId) : ""].filter(Boolean))),
        profileUrls: Array.from(new Set([
          hasPublicProfileToken ? `https://www.zhihu.com/${kind}/${urlToken}` : "",
          profileFromUrl ? `https://www.zhihu.com/${profileFromUrl.kind}/${profileFromUrl.urlToken}` : ""
        ].filter(Boolean)))
      }
    };
  }

  function collectComments(value, out) {
    if (!value || out.length >= 120) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectComments(item, out);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    const user = candidateToUser(value);
    const content = normalizeText(contentToText(value.content || value.excerpt || value.text || value.comment || value.reply_content || ""));
    if (user && (content || value.id || value.comment_id)) {
      out.push({
        id: String(value.id || value.comment_id || ""),
        content: content.slice(0, 240),
        user
      });
    }
    for (const key of ["data", "comments", "comment", "child_comments", "reply_comments", "replies", "paging"]) {
      const child = value[key];
      if (child && key !== "paging") {
        collectComments(child, out);
      }
    }
  }

  function postCommentPayload(url, json) {
    const comments = [];
    collectComments(json, comments);
    if (!comments.length) {
      return;
    }
    const payload = {
      type: MESSAGE_TYPE,
      url,
      comments,
      at: Date.now()
    };
    recentPayloads.push(payload);
    while (recentPayloads.length > 30) {
      recentPayloads.shift();
    }
    window.postMessage(payload, window.location.origin);
  }

  function postHookReady() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (let index = recentPayloads.length - 1; index >= 0; index -= 1) {
      if (recentPayloads[index].at < cutoff) {
        recentPayloads.splice(index, 1);
      }
    }
    window.postMessage({
      type: HOOK_READY_TYPE,
      installedAt,
      replayed: recentPayloads.length,
      at: Date.now()
    }, window.location.origin);
    for (const payload of recentPayloads) {
      window.postMessage({ ...payload, replay: true }, window.location.origin);
    }
  }

  function shouldInspect(url) {
    return API_PATTERN.test(String(url || ""));
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function hookedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (shouldInspect(url)) {
        try {
          response.clone().json()
            .then((json) => postCommentPayload(url, json))
            .catch(() => {});
        } catch (_error) {
          // Keep the page request untouched if the response cannot be cloned.
        }
      }
      return response;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === "function") {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;
    OriginalXHR.prototype.open = function hookedOpen(method, url) {
      this.__zlbUrl = url;
      return originalOpen.apply(this, arguments);
    };
    OriginalXHR.prototype.send = function hookedSend() {
      try {
        this.addEventListener("load", function onLoad() {
          if (!shouldInspect(this.__zlbUrl)) {
            return;
          }
          try {
            postCommentPayload(this.__zlbUrl, JSON.parse(this.responseText));
          } catch (_error) {
            // Ignore non-JSON responses.
          }
        });
      } catch (_error) {
        // Keep the page request untouched if this XHR object rejects listeners.
      }
      return originalSend.apply(this, arguments);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data || {};
    if (data.type === READY_TYPE) {
      postHookReady();
    }
  });

  postHookReady();
})();
