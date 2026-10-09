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
    document.querySelector(".video-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  for (const toggle of document.querySelectorAll("[data-toc-toggle]")) {
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "세부 목차 접기" : "세부 목차 펼치기");
      toggle.closest(".toc-chapter").classList.toggle("is-open", open);
    });
  }

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
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase("ko");
    let visible = 0;
    for (const row of rows) {
      row.hidden = !row.textContent.toLocaleLowerCase("ko").includes(query);
      if (!row.hidden) visible++;
    }
    count.textContent = `${visible}개 구간`;
    empty.hidden = visible > 0;
  });
})();
