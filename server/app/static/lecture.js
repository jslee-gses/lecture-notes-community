(() => {
  "use strict";
  const app = document.getElementById("lecture-app");
  const videoId = app?.dataset.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) return;

  const fallback = document.getElementById("youtube-fallback");
  const playerMessage = document.getElementById("player-message");
  let player = null;
  let ready = false;
  let pendingSeek = null;

  function setFallback(seconds) {
    const url = new URL("https://www.youtube.com/watch");
    url.searchParams.set("v", videoId);
    url.searchParams.set("t", `${Math.floor(seconds)}s`);
    fallback.href = url.toString();
  }

  function showFallback() {
    playerMessage.textContent = "이 영상은 여기서 재생할 수 없습니다. YouTube에서 같은 시점으로 열 수 있습니다.";
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-seek]");
    if (!target) return;
    const seconds = Number(target.dataset.seek);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    setFallback(seconds);
    if (ready) player.seekTo(seconds, true);
    else pendingSeek = seconds;
  });

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activateTab(index, focus = false) {
    tabs.forEach((tab, position) => {
      const active = position === index;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
    });
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(index));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      activateTab(next, true);
    });
  });

  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player("player", {
      videoId,
      playerVars: { origin: window.location.origin, rel: 0 },
      events: {
        onReady: (event) => {
          player = event.target;
          ready = true;
          if (pendingSeek !== null) player.seekTo(pendingSeek, true);
          pendingSeek = null;
        },
        onError: showFallback,
      },
    });
  };
  const apiScript = document.createElement("script");
  apiScript.src = "https://www.youtube.com/iframe_api";
  apiScript.onerror = showFallback;
  document.head.appendChild(apiScript);

  const search = document.getElementById("transcript-search");
  const rows = [...document.querySelectorAll("[data-transcript-row]")];
  const count = document.getElementById("search-count");
  const empty = document.getElementById("search-empty");
  const originalText = new Map(rows.map((row) => [
    row,
    [...row.querySelectorAll(".transcript-copy p")].map((paragraph) => [paragraph, paragraph.textContent]),
  ]));
  function renderHighlight(paragraph, source, query) {
    if (!query) {
      paragraph.textContent = source;
      return;
    }
    const lower = source.toLocaleLowerCase();
    const parts = [];
    let from = 0;
    while (from < source.length) {
      const match = lower.indexOf(query, from);
      if (match === -1) break;
      if (match > from) parts.push(document.createTextNode(source.slice(from, match)));
      const mark = document.createElement("mark");
      mark.textContent = source.slice(match, match + query.length);
      parts.push(mark);
      from = match + query.length;
    }
    parts.push(document.createTextNode(source.slice(from)));
    paragraph.replaceChildren(...parts);
  }
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of rows) {
      const fields = originalText.get(row);
      row.hidden = !fields.some(([, source]) => source.toLocaleLowerCase().includes(query));
      for (const [paragraph, source] of fields) {
        renderHighlight(paragraph, source, query);
      }
      if (!row.hidden) visible++;
    }
    count.textContent = `${visible}개 구간`;
    empty.hidden = visible > 0;
  });
})();
