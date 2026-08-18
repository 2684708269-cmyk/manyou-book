(function () {
  "use strict";

  const DATA_URL = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_1_states_provinces_lakes.geojson";
  const HIGH_RES_DATA_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";
  const STORE_KEY = "wanderbook-regions-v2";
  const seed = {};

  let records = loadRecords();
  let geoData = null;
  let selectedFeature = null;
  let selectedStatus = "planned";
  let pendingPhotos = [];
  let activeFilter = "all";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function loadRecords() {
    try { return { ...seed, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") }; }
    catch (_) { return { ...seed }; }
  }

  function saveRecords() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(records)); }
    catch (_) { showToast("照片较大，部分内容未能保存在浏览器中"); }
  }

  function featureName(feature) {
    const p = feature.properties || {};
    return p.name_zh || p.name || p.name_en || p.gn_name || "未命名地区";
  }

  function countryName(feature) {
    const p = feature.properties || {};
    return p.admin || p.geonunit || p.sov_a3 || "未知国家";
  }

  function regionKey(feature) {
    const p = feature.properties || {};
    const canonicalCountry = p.admin || p.geonunit || p.sov_a3 || countryName(feature);
    const canonicalRegion = p.name || p.name_en || p.name_zh || featureName(feature);
    return `${canonicalCountry}|${canonicalRegion}`;
  }

  function decorateData(data) {
    data.features.forEach((feature, index) => {
      const record = records[regionKey(feature)];
      feature.properties._id = index;
      feature.properties.travel_status = record?.status || "none";
    });
    return data;
  }

  const map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#8fa89a" } }] },
    center: [22, 25],
    zoom: 0.35,
    minZoom: 0,
    maxZoom: 8,
    attributionControl: true,
    renderWorldCopies: false
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  map.on("style.load", async () => {
    map.setProjection({ type: "globe" });
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error("boundary request failed");
      geoData = decorateData(await response.json());
      map.addSource("admin-regions", { type: "geojson", data: geoData });
      map.addLayer({
        id: "regions-fill", type: "fill", source: "admin-regions",
        paint: {
          "fill-color": ["match", ["get", "travel_status"], "visited", "#e47d5c", "planned", "#6f9a88", "friend", "#d7a94d", "#e8e1d3"],
          "fill-opacity": ["case", ["==", ["get", "travel_status"], "none"], 0.78, 0.94]
        }
      });
      map.addLayer({
        id: "regions-line", type: "line", source: "admin-regions",
        paint: { "line-color": "rgba(45,72,62,.46)", "line-width": ["interpolate", ["linear"], ["zoom"], 0, .24, 4, .8, 7, 1.25] }
      });
      map.addLayer({
        id: "regions-highlight", type: "line", source: "admin-regions",
        filter: ["==", ["get", "_id"], -1],
        paint: { "line-color": "#fff9ed", "line-width": 2.4 }
      });
      $("#mapStatus").textContent = `${geoData.features.length.toLocaleString()} 个省州级区域已就绪`;
      map.on("click", "regions-fill", onRegionClick);
      map.on("mouseenter", "regions-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "regions-fill", () => { map.getCanvas().style.cursor = "grab"; });
      updateStats();
      upgradeBoundaryDetail();
    } catch (error) {
      $("#mapStatus").textContent = "边界数据暂时不可用，请检查网络";
      showToast("地图数据加载失败，刷新后可重试");
    }
  });

  async function upgradeBoundaryDetail() {
    $("#mapStatus").textContent = `${geoData.features.length.toLocaleString()} 个区域已就绪 · 正在加载精细边界`;
    try {
      const response = await fetch(HIGH_RES_DATA_URL);
      if (!response.ok) throw new Error("high resolution boundary request failed");
      geoData = decorateData(await response.json());
      map.getSource("admin-regions").setData(geoData);
      $("#mapStatus").textContent = `${geoData.features.length.toLocaleString()} 个省州级区域已就绪`;
    } catch (_) {
      $("#mapStatus").textContent = `${geoData.features.length.toLocaleString()} 个省州级区域已就绪 · 标准精度`;
    }
  }

  function onRegionClick(event) {
    const feature = event.features?.[0];
    if (!feature) return;
    selectedFeature = feature;
    openRegionModal(feature);
  }

  function openRegionModal(feature) {
    const record = records[regionKey(feature)] || {};
    selectedStatus = record.status || "planned";
    pendingPhotos = [...(record.photos || [])];
    $("#regionTitle").textContent = featureName(feature);
    $("#regionCountry").textContent = countryName(feature);
    $("#regionNote").value = record.note || "";
    $$("[data-status]").forEach((button) => button.classList.toggle("selected", button.dataset.status === selectedStatus));
    renderPreviews();
    openModal("regionModal");
  }

  function openModal(id) { $(`#${id}`).hidden = false; document.body.style.overflow = "hidden"; }
  function closeModal(id) { $(`#${id}`).hidden = true; document.body.style.overflow = ""; }

  function updateMapData() {
    if (!geoData || !map.getSource("admin-regions")) return;
    decorateData(geoData);
    map.getSource("admin-regions").setData(geoData);
    applyFilter(activeFilter);
  }

  function applyFilter(filter) {
    activeFilter = filter;
    if (!map.getLayer("regions-fill")) return;
    map.setPaintProperty("regions-fill", "fill-opacity", filter === "all"
      ? ["case", ["==", ["get", "travel_status"], "none"], .78, .94]
      : ["case", ["==", ["get", "travel_status"], filter], .96, .16]);
  }

  function updateStats() {
    const all = Object.values(records);
    $("#visitedCount").textContent = all.filter((r) => r.status === "visited").length;
    $("#plannedCount").textContent = all.filter((r) => r.status === "planned").length;
    $("#photoCount").textContent = all.reduce((sum, r) => sum + (r.photos?.length || 0), 0);
  }

  function renderPreviews() {
    $("#previewGrid").innerHTML = pendingPhotos.map((src) => `<img src="${src}" alt="待上传的旅行照片" />`).join("");
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  $$("[data-status]").forEach((button) => button.addEventListener("click", () => {
    selectedStatus = button.dataset.status;
    $$("[data-status]").forEach((item) => item.classList.toggle("selected", item === button));
  }));

  $("#photoUpload").addEventListener("change", (event) => {
    const files = [...event.target.files].slice(0, 4 - pendingPhotos.length);
    files.forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => { pendingPhotos.push(reader.result); renderPreviews(); };
      reader.readAsDataURL(file);
    });
    event.target.value = "";
  });

  $("#saveRegion").addEventListener("click", () => {
    if (!selectedFeature) return;
    records[regionKey(selectedFeature)] = { status: selectedStatus, note: $("#regionNote").value.trim(), photos: pendingPhotos };
    saveRecords(); updateMapData(); updateStats(); closeModal("regionModal");
    showToast(selectedStatus === "visited" ? "这段旅程已经点亮 ✦" : "已加入我们的旅行愿望");
  });

  $("#clearRegion").addEventListener("click", () => {
    if (!selectedFeature) return;
    delete records[regionKey(selectedFeature)]; saveRecords(); updateMapData(); updateStats(); closeModal("regionModal");
    showToast("已清除这个地区的标记");
  });

  $$("[data-close]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
  $$(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeModal(backdrop.id); }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") $$(".modal-backdrop:not([hidden])").forEach((modal) => closeModal(modal.id)); });

  $$(".filter-pill").forEach((button) => button.addEventListener("click", () => {
    $$(".filter-pill").forEach((item) => item.classList.toggle("active", item === button));
    applyFilter(button.dataset.filter);
  }));

  $("#resetView").addEventListener("click", () => map.flyTo({ center: [22, 25], zoom: .35, bearing: 0, pitch: 0, duration: 1400 }));
  map.once("dragstart", () => { $("#mapHint").style.opacity = "0"; });
  map.once("zoomstart", () => { $("#mapHint").style.opacity = "0"; });

  $("#searchButton").addEventListener("click", () => {
    const panel = $("#searchPopover"); panel.hidden = !panel.hidden;
    if (!panel.hidden) setTimeout(() => $("#regionSearch").focus(), 0);
  });

  $("#regionSearch").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (!query) { $("#searchResults").innerHTML = ""; return; }
    if (!geoData) { $("#searchResults").innerHTML = "<p>行政区数据正在加载…</p>"; return; }
    const matches = geoData.features.filter((f) => `${featureName(f)} ${countryName(f)} ${JSON.stringify(f.properties)}`.toLowerCase().includes(query)).slice(0, 8);
    $("#searchResults").innerHTML = matches.map((f) => `<button class="search-result" data-id="${f.properties._id}">${featureName(f)}<small>${countryName(f)}</small></button>`).join("") || "<p>没有找到这个地区</p>";
  });

  $("#searchResults").addEventListener("click", (event) => {
    const button = event.target.closest("[data-id]"); if (!button) return;
    const feature = geoData.features.find((f) => String(f.properties._id) === button.dataset.id); if (!feature) return;
    const bounds = new maplibregl.LngLatBounds();
    const addCoords = (coords) => typeof coords[0] === "number" ? bounds.extend(coords) : coords.forEach(addCoords);
    addCoords(feature.geometry.coordinates); map.fitBounds(bounds, { padding: 100, maxZoom: 5, duration: 1300 });
    map.setFilter("regions-highlight", ["==", ["get", "_id"], feature.properties._id]);
    $("#searchPopover").hidden = true;
    selectedFeature = feature; setTimeout(() => openRegionModal(feature), 500);
  });

  $("#inviteButton").addEventListener("click", () => openModal("inviteModal"));
  $("#copyInvite").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#inviteCode").textContent); showToast("邀请码已复制"); }
    catch (_) { showToast("邀请码：" + $("#inviteCode").textContent); }
  });
  $("#joinButton").addEventListener("click", () => {
    const code = $("#joinCode").value.trim().toUpperCase();
    $("#inviteMessage").textContent = code.length >= 6 ? `已加入 ${code} 的共同地图（演示模式）` : "请输入正确的邀请码";
  });
  $("#openGallery").addEventListener("click", () => showToast("相册将在你上传第一组照片后生成"));
})();
