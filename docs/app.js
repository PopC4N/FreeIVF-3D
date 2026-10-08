"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const el = Object.fromEntries([
    "viewer", "scene-switcher", "fusion-image", "image-scene-name", "image-view-label",
    "image-placeholder", "placeholder-text", "error-panel", "error-message", "retry-button",
    "open-frame", "scene-description", "trajectory-svg", "trajectory-path", "query-map-points",
    "current-halo", "current-point", "map-unavailable", "projection-note", "query-buttons",
    "progress-value", "frame-counter", "progress-slider", "timeline-markers", "previous-frame",
    "next-frame", "play-button", "play-icon", "play-label", "playback-speed", "load-status",
    "load-status-text"
  ].map((id) => [id, byId(id)]));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const source = window.TRAJECTORY_DATA;
  const scenes = (Array.isArray(source) ? source : source?.scenes || []).filter((scene) =>
    scene && (scene.frames?.length || scene.frameCount > 0) && (scene.frames || scene.framePattern)
  );
  const svgNS = "http://www.w3.org/2000/svg";
  const state = { scene: null, index: 0, displayed: -1, request: 0, playing: false, raf: 0, startTime: 0, startProgress: 0, loading: false, failed: false };

  class FrameCache {
    constructor(limit = 16, concurrency = 4) {
      this.limit = limit;
      this.concurrency = concurrency;
      this.cache = new Map();
      this.pending = new Map();
      this.queue = [];
      this.active = 0;
    }
    load(url, priority = false) {
      if (this.cache.has(url)) {
        const image = this.cache.get(url);
        this.cache.delete(url);
        this.cache.set(url, image);
        return Promise.resolve(image);
      }
      if (this.pending.has(url)) {
        const task = this.pending.get(url);
        if (priority && this.queue.includes(task)) {
          this.queue = this.queue.filter((item) => item !== task);
          this.queue.unshift(task);
        }
        return task.promise;
      }
      const task = { url };
      task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
      this.pending.set(url, task);
      if (priority) this.queue.unshift(task); else this.queue.push(task);
      this.pump();
      return task.promise;
    }
    retainQueued(urls) {
      this.queue = this.queue.filter((task) => {
        if (urls.has(task.url)) return true;
        this.pending.delete(task.url);
        task.reject(new DOMException("Frame request superseded", "AbortError"));
        return false;
      });
    }
    pump() {
      while (this.active < this.concurrency && this.queue.length) {
        const task = this.queue.shift();
        this.active += 1;
        const image = new Image();
        image.decoding = "async";
        const finish = () => {
          image.onload = null;
          image.onerror = null;
          this.active -= 1;
          this.pending.delete(task.url);
          this.pump();
        };
        image.onload = async () => {
          try { if (image.decode) await image.decode(); } catch (_) {}
          this.cache.set(task.url, image);
          while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
          task.resolve(image);
          finish();
        };
        image.onerror = () => { task.reject(new Error("Unable to load this rendered frame.")); finish(); };
        image.src = task.url;
      }
    }
  }

  const cache = new FrameCache();
  const frameCount = (scene = state.scene) => scene?.frames?.length || scene?.frameCount || 0;
  const progressAt = (index, scene = state.scene) => scene.frameProgress?.[index] ?? index / Math.max(1, frameCount(scene) - 1);
  const frameUrl = (index, scene = state.scene) => {
    const entry = scene.frames?.[index];
    if (entry) return typeof entry === "string" ? entry : entry.src || entry.url;
    const number = String(index + (scene.indexOffset || 0)).padStart(scene.indexPad || 0, "0");
    return scene.framePattern.replace("{index}", number);
  };
  const nearestFrame = (progress) => {
    const sequence = state.scene.frameProgress;
    const count = frameCount();
    if (!sequence || sequence.length !== count) return Math.round(clamp(progress, 0, 1) * (count - 1));
    let low = 0, high = count - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (sequence[mid] < progress) low = mid + 1; else high = mid;
    }
    return low > 0 && Math.abs(sequence[low - 1] - progress) < Math.abs(sequence[low] - progress) ? low - 1 : low;
  };
  const shortQuery = (query, index) => query.shortLabel || `Q${index + 1}`;
  const svgElement = (name, attrs) => {
    const element = document.createElementNS(svgNS, name);
    Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  };
  const positionAt = (index) => {
    const points = state.scene.points;
    if (!points?.length) return null;
    if (points.length === frameCount()) return points[index];
    if (Number.isFinite(points[0].frame)) return points.reduce((best, point) => Math.abs(point.frame - index) < Math.abs(best.frame - index) ? point : best);
    return null;
  };
  const plotPosition = (point) => ({ x: 160 + (point.x - 0.5) * 270, y: 125 + (point.y - 0.5) * 270 });

  function setStatus(message, kind = "ready") {
    el["load-status-text"].textContent = message;
    el["load-status"].classList.toggle("is-loading", kind === "loading");
    el["load-status"].classList.toggle("is-error", kind === "error");
  }

  function updateProgress() {
    const progress = progressAt(state.index);
    const percent = `${(progress * 100).toFixed(1)}%`;
    el["progress-slider"].value = String(progress);
    el["progress-slider"].style.setProperty("--progress", percent);
    el["progress-slider"].setAttribute("aria-valuetext", `${percent}, requested frame ${state.index + 1} of ${frameCount()}`);
    el["progress-value"].textContent = percent;
    el["previous-frame"].disabled = state.index === 0;
    el["next-frame"].disabled = state.index === frameCount() - 1;
  }

  function updateDisplayedFrame() {
    const index = state.displayed;
    const count = frameCount();
    el["frame-counter"].textContent = `Frame ${String(index + 1).padStart(3, "0")} / ${count}`;
    const query = (state.scene.queries || []).find((item) => item.frame === index);
    el["image-view-label"].textContent = query ? `Fusion view · ${query.label}` : `Fusion view · t = ${progressAt(index).toFixed(3)}`;
    el["fusion-image"].alt = `${state.scene.name}, fusion rendered at trajectory progress ${progressAt(index).toFixed(3)}, frame ${index + 1} of ${count}`;
    el["open-frame"].href = frameUrl(index);
    el["open-frame"].removeAttribute("aria-disabled");
    const position = positionAt(index);
    if (position) {
      const point = plotPosition(position);
      [el["current-point"], el["current-halo"]].forEach((circle) => { circle.setAttribute("cx", point.x); circle.setAttribute("cy", point.y); });
    }
    el["query-buttons"].querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.frame) === index)));
  }

  function prefetchNeighbors(index, scene) {
    const offsets = navigator.connection?.saveData ? [1] : state.playing ? [1, 2, 3, 4, -1] : [1, -1, 2, -2];
    offsets.forEach((offset) => {
      const next = index + offset;
      if (next >= 0 && next < frameCount(scene)) cache.load(frameUrl(next, scene)).catch(() => {});
    });
  }

  async function showFrame(index, force = false) {
    if (!state.scene) return;
    index = clamp(index, 0, frameCount() - 1);
    if (!force && index === state.index && (state.loading || (state.displayed === index && !state.failed))) return;
    state.index = index;
    state.loading = true;
    state.failed = false;
    const request = ++state.request;
    const scene = state.scene;
    updateProgress();
    el["error-panel"].hidden = true;
    el["fusion-image"].setAttribute("aria-busy", "true");
    setStatus(`Loading frame ${index + 1}`, "loading");
    const keep = new Set([index - 2, index - 1, index, index + 1, index + 2, index + 3, index + 4].filter((n) => n >= 0 && n < frameCount()).map((n) => frameUrl(n)));
    cache.retainQueued(keep);
    try {
      const image = await cache.load(frameUrl(index, scene), true);
      if (request !== state.request || scene !== state.scene) return;
      el["fusion-image"].src = image.src;
      el["fusion-image"].hidden = false;
      el["image-placeholder"].hidden = true;
      state.displayed = index;
      state.loading = false;
      el["fusion-image"].setAttribute("aria-busy", "false");
      updateDisplayedFrame();
      setStatus(`Frame ${index + 1} loaded · ${frameCount()} views`);
      prefetchNeighbors(index, scene);
    } catch (error) {
      if (request !== state.request || scene !== state.scene || error.name === "AbortError") return;
      state.loading = false;
      state.failed = true;
      pause();
      el["fusion-image"].setAttribute("aria-busy", "false");
      el["image-placeholder"].hidden = true;
      el["error-panel"].hidden = false;
      el["error-message"].textContent = `Frame ${index + 1} could not be loaded. Check the connection or choose another position.`;
      setStatus(`Frame ${index + 1} unavailable`, "error");
    }
  }

  function drawTrajectory() {
    const scene = state.scene;
    const validPoints = scene.points?.length && scene.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    el["trajectory-svg"].toggleAttribute("hidden", !validPoints);
    el["map-unavailable"].hidden = !!validPoints;
    el["projection-note"].textContent = `${scene.projectionLabel || "Camera-center projection"}. PCA plane, equal scale on both axes.`;
    el["query-map-points"].replaceChildren();
    el["query-buttons"].replaceChildren();
    el["timeline-markers"].replaceChildren();
    if (validPoints) {
      el["trajectory-path"].setAttribute("d", scene.points.map((point, index) => { const p = plotPosition(point); return `${index ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`; }).join(" "));
      const first = plotPosition(positionAt(0) || scene.points[0]);
      [el["current-point"], el["current-halo"]].forEach((circle) => { circle.setAttribute("cx", first.x); circle.setAttribute("cy", first.y); });
      el["trajectory-svg"].setAttribute("aria-label", `${scene.name}, ${scene.projectionLabel || "camera-center projection"}, with manuscript query views and current rendered view`);
    }
    (scene.queries || []).forEach((query, i) => {
      if (!Number.isInteger(query.frame) || query.frame < 0 || query.frame >= frameCount()) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "query-button";
      button.dataset.frame = query.frame;
      button.textContent = shortQuery(query, i);
      button.title = `${query.label}, t = ${progressAt(query.frame).toFixed(3)}`;
      button.setAttribute("aria-label", `Jump to ${query.label}, frame ${query.frame + 1}`);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => { pause(); showFrame(query.frame); });
      el["query-buttons"].append(button);
      const tick = document.createElement("span");
      tick.className = "timeline-marker";
      tick.style.left = `${progressAt(query.frame) * 100}%`;
      tick.dataset.label = shortQuery(query, i);
      el["timeline-markers"].append(tick);
      const sourcePoint = validPoints ? positionAt(query.frame) : null;
      if (sourcePoint) {
        const p = plotPosition(sourcePoint);
        const group = svgElement("g", { class: "map-query", role: "button", tabindex: 0, "aria-label": `Jump to ${query.label}` });
        const hit = svgElement("circle", { cx: p.x, cy: p.y, r: 14, fill: "transparent" });
        const dot = svgElement("circle", { cx: p.x, cy: p.y, r: 4, class: "map-query-dot" });
        const label = svgElement("text", { x: p.x + (p.x > 275 ? -10 : 9), y: p.y - 9, "text-anchor": p.x > 275 ? "end" : "start", class: "map-query-text" });
        label.textContent = shortQuery(query, i);
        group.append(hit, dot, label);
        group.addEventListener("click", () => { pause(); showFrame(query.frame); });
        group.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.code === "Space") {
            event.preventDefault(); event.stopPropagation(); pause(); showFrame(query.frame);
          }
        });
        el["query-map-points"].append(group);
      }
    });
  }

  function selectScene(scene) {
    pause();
    state.scene = scene;
    state.index = 0;
    state.displayed = -1;
    state.request += 1;
    state.loading = false;
    state.failed = false;
    el["image-scene-name"].textContent = scene.name;
    el["scene-description"].textContent = scene.description || "Fusion rendered along the manuscript's novel camera trajectory.";
    el["fusion-image"].hidden = true;
    el["fusion-image"].removeAttribute("src");
    el["image-placeholder"].hidden = false;
    el["error-panel"].hidden = true;
    el["image-view-label"].textContent = "Fusion view";
    el["open-frame"].removeAttribute("href");
    el["open-frame"].setAttribute("aria-disabled", "true");
    el["frame-counter"].textContent = `Frame 000 / ${frameCount()}`;
    el["scene-switcher"].querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.scene === scene.id)));
    drawTrajectory();
    showFrame(0, true);
  }

  function pause() {
    state.playing = false;
    cancelAnimationFrame(state.raf);
    el["play-label"].textContent = "Play";
    el["play-button"].setAttribute("aria-label", "Play trajectory");
    el["play-icon"].innerHTML = '<path d="m7 4 9 6-9 6z"/>';
  }

  function play() {
    if (!state.scene || frameCount() < 2 || state.failed) return;
    if (state.index >= frameCount() - 1) showFrame(0);
    state.playing = true;
    state.startTime = performance.now();
    state.startProgress = progressAt(state.index);
    el["play-label"].textContent = "Pause";
    el["play-button"].setAttribute("aria-label", "Pause trajectory");
    el["play-icon"].innerHTML = '<path d="M5 4h4v12H5zM12 4h4v12h-4z"/>';
    state.raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    if (!state.playing) return;
    const speed = Number(el["playback-speed"].value);
    const duration = state.scene.duration || (frameCount() - 1) / (state.scene.fps || 24);
    const progress = clamp(state.startProgress + (now - state.startTime) / 1000 * speed / duration, 0, 1);
    if (!state.loading) showFrame(nearestFrame(progress));
    if (progress >= 1 && state.index === frameCount() - 1) pause(); else state.raf = requestAnimationFrame(tick);
  }

  function step(direction) { pause(); showFrame(state.index + direction); }

  el["progress-slider"].addEventListener("input", (event) => { pause(); showFrame(nearestFrame(Number(event.target.value))); });
  el["previous-frame"].addEventListener("click", () => step(-1));
  el["next-frame"].addEventListener("click", () => step(1));
  el["play-button"].addEventListener("click", () => state.playing ? pause() : play());
  el["playback-speed"].addEventListener("change", () => { if (state.playing) { pause(); play(); } });
  el["retry-button"].addEventListener("click", () => showFrame(state.index, true));
  el["viewer"].addEventListener("keydown", (event) => {
    if (!state.scene || event.altKey || event.ctrlKey || event.metaKey || event.target.matches("select")) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      step(event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1);
    } else if (event.code === "Space" && !event.target.matches("button, a")) {
      event.preventDefault();
      state.playing ? pause() : play();
    } else if (event.key === "Home" && event.target === el["progress-slider"]) {
      event.preventDefault(); pause(); showFrame(0);
    } else if (event.key === "End" && event.target === el["progress-slider"]) {
      event.preventDefault(); pause(); showFrame(frameCount() - 1);
    }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });

  if (!scenes.length) {
    el["image-placeholder"].hidden = true;
    el["error-panel"].hidden = false;
    el["error-message"].textContent = "The trajectory data could not be loaded. Check that assets/trajectories.js is available.";
    el["retry-button"].hidden = true;
    ["progress-slider", "previous-frame", "next-frame", "play-button", "playback-speed"].forEach((id) => { el[id].disabled = true; });
    setStatus("Sequence data unavailable", "error");
    return;
  }

  scenes.forEach((scene, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scene-button";
    button.dataset.scene = scene.id;
    button.setAttribute("aria-pressed", "false");
    const number = document.createElement("span");
    number.className = "scene-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const label = document.createElement("span");
    label.textContent = scene.name;
    button.append(number, label);
    button.addEventListener("click", () => { if (state.scene !== scene) selectScene(scene); });
    el["scene-switcher"].append(button);
  });
  selectScene(scenes[0]);
})();
