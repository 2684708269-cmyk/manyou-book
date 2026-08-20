(async function () {
  "use strict";

  const DATA_URL = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_1_states_provinces_lakes.geojson";
  const HIGH_RES_DATA_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";
  const PHOTO_BUCKET = "travel-photos";
  const config = window.WANDERBOOK_SUPABASE || {};
  const backendReady = Boolean(config.url && config.anonKey && window.supabase?.createClient);
  const db = backendReady ? window.supabase.createClient(config.url, config.anonKey) : null;

  let records = {};
  let geoData = null;
  let selectedFeature = null;
  let selectedStatus = "planned";
  let pendingPhotos = [];
  let activeFilter = "all";
  let currentUser = null;
  let currentProfile = null;
  let availableMaps = [];
  let activeMapId = null;
  let realtimeChannel = null;
  let reloadTimer = null;
  let audioContext = null;
  let musicTimer = null;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

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
      feature.properties.friend_marked = Boolean(record?.updated_by && record.updated_by !== currentUser?.id);
    });
    return data;
  }

  const map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#0b1215" } }] },
    center: [22, 25], zoom: 0.35, minZoom: 0, maxZoom: 8,
    attributionControl: true, renderWorldCopies: false
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  map.on("style.load", async () => {
    map.setProjection({ type: "globe" });
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error("boundary request failed");
      geoData = decorateData(await response.json());
      map.addSource("admin-regions", { type: "geojson", data: geoData });
      map.addLayer({ id: "regions-fill", type: "fill", source: "admin-regions", paint: {
        "fill-color": ["match", ["get", "travel_status"], "visited", "#b98b4b", "planned", "#496b5d", "#30332e"],
        "fill-opacity": ["case", ["==", ["get", "travel_status"], "none"], 0.82, 0.96]
      }});
      map.addLayer({ id: "regions-line", type: "line", source: "admin-regions", paint: {
        "line-color": ["case", ["==", ["get", "friend_marked"], true], "#d5a541", "rgba(45,72,62,.46)"],
        "line-width": ["interpolate", ["linear"], ["zoom"],
          0, ["case", ["==", ["get", "friend_marked"], true], 1.1, .24],
          4, ["case", ["==", ["get", "friend_marked"], true], 1.7, .8],
          7, ["case", ["==", ["get", "friend_marked"], true], 2.2, 1.25]
        ]
      }});
      map.addLayer({ id: "regions-highlight", type: "line", source: "admin-regions", filter: ["==", ["get", "_id"], -1], paint: { "line-color": "#fff9ed", "line-width": 2.4 } });
      $("#mapStatus").textContent = `${geoData.features.length.toLocaleString()} 个省州级区域已就绪`;
      map.on("click", "regions-fill", onRegionClick);
      map.on("mouseenter", "regions-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "regions-fill", () => { map.getCanvas().style.cursor = "grab"; });
      updateStats();
      upgradeBoundaryDetail();
    } catch (_) {
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
    pendingPhotos = (record.photos || []).map((photo) => ({ ...photo, isExisting: true }));
    $("#regionTitle").textContent = featureName(feature);
    $("#regionCountry").textContent = countryName(feature);
    $("#regionNote").value = record.note || "";
    $$('[data-status]').forEach((button) => button.classList.toggle("selected", button.dataset.status === selectedStatus));
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
    $("#visitedCount").textContent = all.filter((record) => record.status === "visited").length;
    $("#plannedCount").textContent = all.filter((record) => record.status === "planned").length;
    $("#photoCount").textContent = all.reduce((sum, record) => sum + (record.photos?.length || 0), 0);
    updateMemoryCard(all);
  }

  function updateMemoryCard(allRecords) {
    const latest = [...allRecords].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))[0];
    const photo = latest?.photos?.[0];
    if (!latest || !photo?.url) {
      $("#memoryContent").className = "memory-empty";
      $("#memoryContent").removeAttribute("style");
      $("#memoryContent").innerHTML = "<span>＋</span><strong>还没有旅行照片</strong><small>点亮去过的地区，上传第一张回忆</small>";
      $("#memoryQuote").textContent = currentUser ? "地图还是空白的，下一站从哪里开始？" : "登录后，旅途记忆会安全保存在云端。";
      return;
    }
    $("#memoryContent").className = "memory-photo memory-photo-live";
    $("#memoryContent").style.backgroundImage = `linear-gradient(transparent 45%, rgba(15,38,31,.66)), url("${photo.url}")`;
    $("#memoryContent").innerHTML = `<div class="photo-caption"><small>${new Date(latest.updated_at).toLocaleDateString("zh-CN")}</small><strong>${escapeHtml(latest.region_name)}</strong></div>`;
    $("#memoryQuote").textContent = latest.note ? `“${latest.note}”` : "一张照片，记住一次抵达。";
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function renderPreviews() {
    $("#previewGrid").innerHTML = pendingPhotos.map((photo) => `<img src="${photo.url}" alt="旅行照片预览" />`).join("");
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function setButtonLoading(button, loading) {
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
  }

  function requireSession(message = "登录后才能保存旅程") {
    if (currentUser && activeMapId) return true;
    showAuthModal(message);
    return false;
  }

  function showAuthModal(message) {
    const signedIn = Boolean(currentUser);
    $("#authEmail").closest("label").hidden = signedIn;
    $("#sendMagicLink").hidden = signedIn;
    $("#accountDetails").hidden = !signedIn;
    $("#accountEmail").textContent = currentUser?.email || "";
    $("#authMessage").textContent = backendReady ? (message || "无需密码，点击邮件中的链接即可登录。") : "Supabase 项目尚未配置，暂时无法登录。";
    $("#sendMagicLink").disabled = !backendReady;
    openModal("authModal");
  }

  async function initializeBackend() {
    if (!backendReady) { renderAccountState(); updateStats(); return; }
    const { data: { session } } = await db.auth.getSession();
    await handleSession(session);
    db.auth.onAuthStateChange((_event, nextSession) => { window.setTimeout(() => handleSession(nextSession), 0); });
  }

  async function handleSession(session) {
    currentUser = session?.user || null;
    if (!currentUser) {
      currentProfile = null; availableMaps = []; activeMapId = null; records = {};
      if (realtimeChannel) await db.removeChannel(realtimeChannel);
      realtimeChannel = null;
      renderAccountState(); renderMapSelector(); updateMapData(); updateStats();
      return;
    }
    await loadWorkspace();
  }

  async function loadWorkspace(preferredMapId) {
    const [{ data: profile, error: profileError }, { data: memberships, error: membershipError }] = await Promise.all([
      db.from("profiles").select("id,display_name,invite_code").eq("id", currentUser.id).single(),
      db.from("map_members").select("map_id,role,joined_at,maps(id,name,owner_id,created_at)").order("joined_at", { ascending: true })
    ]);
    if (profileError || membershipError) { showToast("云端资料加载失败，请刷新后重试"); return; }
    currentProfile = profile;
    availableMaps = (memberships || []).map((item) => ({ ...item.maps, role: item.role })).filter((item) => item?.id);
    const remembered = sessionStorage.getItem("wanderbook-active-map");
    const candidate = preferredMapId || remembered;
    activeMapId = availableMaps.some((item) => item.id === candidate) ? candidate : availableMaps[0]?.id || null;
    if (activeMapId) sessionStorage.setItem("wanderbook-active-map", activeMapId);
    renderAccountState(); renderMapSelector();
    await loadRemoteRecords();
    bindRealtime();
  }

  function renderAccountState() {
    const label = currentProfile?.display_name || currentUser?.email?.split("@")[0] || "登录";
    $("#accountLabel").textContent = label;
    $("#accountInitial").textContent = currentUser ? label.slice(0, 1).toUpperCase() : "旅";
    $("#inviteCode").textContent = currentProfile?.invite_code || "登录后生成";
  }

  function renderMapSelector() {
    $("#mapSwitcherWrap").hidden = availableMaps.length < 2;
    $("#mapSelector").innerHTML = availableMaps.map((item) => `<option value="${item.id}" ${item.id === activeMapId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  }

  async function loadRemoteRecords() {
    if (!activeMapId) { records = {}; updateMapData(); updateStats(); return; }
    const [{ data: marks, error: marksError }, { data: photos, error: photosError }] = await Promise.all([
      db.from("region_marks").select("id,region_key,region_name,country_name,status,note,created_by,updated_by,updated_at").eq("map_id", activeMapId),
      db.from("region_photos").select("id,region_key,storage_path,uploaded_by,created_at").eq("map_id", activeMapId).order("created_at", { ascending: false })
    ]);
    if (marksError || photosError) { showToast("旅行数据加载失败"); return; }
    const paths = (photos || []).map((photo) => photo.storage_path);
    const signedByPath = {};
    if (paths.length) {
      const { data: signed } = await db.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
      (signed || []).forEach((item) => { if (item.signedUrl) signedByPath[item.path] = item.signedUrl; });
    }
    records = {};
    (marks || []).forEach((mark) => { records[mark.region_key] = { ...mark, photos: [] }; });
    (photos || []).forEach((photo) => {
      if (records[photo.region_key]) records[photo.region_key].photos.push({ ...photo, url: signedByPath[photo.storage_path] || "" });
    });
    updateMapData(); updateStats();
  }

  function bindRealtime() {
    if (!db || !activeMapId) return;
    if (realtimeChannel) db.removeChannel(realtimeChannel);
    realtimeChannel = db.channel(`map-${activeMapId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "region_marks", filter: `map_id=eq.${activeMapId}` }, scheduleReload)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "region_marks", filter: `map_id=eq.${activeMapId}` }, scheduleReload)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "region_marks" }, scheduleReload)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "region_photos", filter: `map_id=eq.${activeMapId}` }, scheduleReload)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "region_photos", filter: `map_id=eq.${activeMapId}` }, scheduleReload)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "region_photos" }, scheduleReload)
      .subscribe();
  }

  function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadRemoteRecords, 350); }

  async function uploadNewPhotos(key) {
    for (const photo of pendingPhotos.filter((item) => item.file)) {
      const extension = photo.file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = `${activeMapId}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await db.storage.from(PHOTO_BUCKET).upload(path, photo.file, { cacheControl: "3600", upsert: false });
      if (uploadError) throw uploadError;
      const { error: rowError } = await db.from("region_photos").insert({ map_id: activeMapId, region_key: key, storage_path: path, uploaded_by: currentUser.id });
      if (rowError) { await db.storage.from(PHOTO_BUCKET).remove([path]); throw rowError; }
    }
  }

  async function saveSelectedRegion() {
    if (!selectedFeature || !requireSession()) return;
    const button = $("#saveRegion"); setButtonLoading(button, true);
    const key = regionKey(selectedFeature); const existing = records[key];
    const payload = { map_id: activeMapId, region_key: key, region_name: featureName(selectedFeature), country_name: countryName(selectedFeature), status: selectedStatus,
      note: $("#regionNote").value.trim(), created_by: existing?.created_by || currentUser.id, updated_by: currentUser.id };
    try {
      const { error } = await db.from("region_marks").upsert(payload, { onConflict: "map_id,region_key" });
      if (error) throw error;
      await uploadNewPhotos(key); await loadRemoteRecords(); closeModal("regionModal");
      showToast(selectedStatus === "visited" ? "这段旅程已经点亮 ✦" : "已加入我们的旅行愿望");
    } catch (error) {
      showToast(error.message?.includes("row-level") ? "你没有修改这张地图的权限" : "保存失败，请稍后重试");
    } finally { setButtonLoading(button, false); }
  }

  async function clearSelectedRegion() {
    if (!selectedFeature || !requireSession()) return;
    const key = regionKey(selectedFeature); const record = records[key];
    if (!record || !window.confirm("确认清除这个地区及其照片吗？此操作无法撤销。")) return;
    const paths = (record.photos || []).map((photo) => photo.storage_path).filter(Boolean);
    try {
      if (paths.length) await db.storage.from(PHOTO_BUCKET).remove(paths);
      const { error: photoError } = await db.from("region_photos").delete().eq("map_id", activeMapId).eq("region_key", key);
      if (photoError) throw photoError;
      const { error: markError } = await db.from("region_marks").delete().eq("map_id", activeMapId).eq("region_key", key);
      if (markError) throw markError;
      await loadRemoteRecords(); closeModal("regionModal"); showToast("已清除这个地区的标记");
    } catch (_) { showToast("清除失败，请稍后重试"); }
  }

  async function sendMagicLink() {
    if (!backendReady) return;
    const email = $("#authEmail").value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { $("#authMessage").textContent = "请输入正确的邮箱地址。"; return; }
    const button = $("#sendMagicLink"); setButtonLoading(button, true);
    const { error } = await db.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
    $("#authMessage").textContent = error ? `发送失败：${error.message}` : "登录邮件已发送，请前往邮箱点击链接。";
    setButtonLoading(button, false);
  }

  async function joinSharedMap() {
    if (!requireSession("登录后才能加入朋友的地图")) return;
    const code = $("#joinCode").value.trim().toUpperCase();
    if (code.length !== 10) { $("#inviteMessage").textContent = "请输入 10 位邀请码。"; return; }
    const button = $("#joinButton"); button.disabled = true;
    const { data: joinedMapId, error } = await db.rpc("join_map_by_invite", { p_invite_code: code });
    if (error) $("#inviteMessage").textContent = error.message.includes("INVALID_INVITE_CODE") ? "邀请码不存在，请检查后重试。" : "加入失败，请稍后重试。";
    else { $("#inviteMessage").textContent = "加入成功，正在打开共同地图…"; await loadWorkspace(joinedMapId); setTimeout(() => closeModal("inviteModal"), 600); }
    button.disabled = false;
  }

  function toggleMusic() {
    if (audioContext) { stopMusic(); return; }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) { showToast("当前浏览器不支持背景音乐"); return; }
    audioContext = new AudioContextClass();
    const master = audioContext.createGain(); master.gain.value = 0.035; master.connect(audioContext.destination);
    const chords = [[220,277.18,329.63],[196,246.94,293.66],[174.61,220,261.63],[196,246.94,329.63]]; let chordIndex = 0;
    const playChord = () => {
      if (!audioContext) return;
      const now = audioContext.currentTime;
      chords[chordIndex++ % chords.length].forEach((frequency, index) => {
        const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain();
        oscillator.type = index === 0 ? "sine" : "triangle"; oscillator.frequency.value = frequency / 2; oscillator.detune.value = index * 3;
        gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.32, now + 1.8); gain.gain.exponentialRampToValueAtTime(0.0001, now + 7.8);
        oscillator.connect(gain).connect(master); oscillator.start(now); oscillator.stop(now + 8);
      });
    };
    playChord(); musicTimer = setInterval(playChord, 7600);
    $("#musicButton").classList.add("music-playing"); $("#musicButton").setAttribute("aria-label", "关闭背景音乐"); showToast("背景音乐已开启");
  }

  function stopMusic() {
    clearInterval(musicTimer); musicTimer = null; audioContext?.close(); audioContext = null;
    $("#musicButton").classList.remove("music-playing"); $("#musicButton").setAttribute("aria-label", "播放背景音乐"); showToast("背景音乐已关闭");
  }

  $$('[data-status]').forEach((button) => button.addEventListener("click", () => {
    selectedStatus = button.dataset.status;
    $$('[data-status]').forEach((item) => item.classList.toggle("selected", item === button));
  }));

  $("#photoUpload").addEventListener("change", (event) => {
    [...event.target.files].slice(0, 4 - pendingPhotos.length).forEach((file) => {
      if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) { showToast("请选择小于 10MB 的图片"); return; }
      pendingPhotos.push({ file, url: URL.createObjectURL(file), isExisting: false });
    });
    renderPreviews(); event.target.value = "";
  });

  $("#saveRegion").addEventListener("click", saveSelectedRegion);
  $("#clearRegion").addEventListener("click", clearSelectedRegion);
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
  $$(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeModal(backdrop.id); }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") $$(".modal-backdrop:not([hidden])").forEach((modal) => closeModal(modal.id)); });
  $$(".filter-pill").forEach((button) => button.addEventListener("click", () => {
    $$(".filter-pill").forEach((item) => item.classList.toggle("active", item === button)); applyFilter(button.dataset.filter);
  }));

  $("#resetView").addEventListener("click", () => map.flyTo({ center: [22, 25], zoom: .35, bearing: 0, pitch: 0, duration: 1400 }));
  map.once("dragstart", () => { $("#mapHint").style.opacity = "0"; });
  map.once("zoomstart", () => { $("#mapHint").style.opacity = "0"; });
  $("#musicButton").addEventListener("click", toggleMusic);
  $("#searchButton").addEventListener("click", () => {
    const panel = $("#searchPopover"); panel.hidden = !panel.hidden;
    if (!panel.hidden) setTimeout(() => $("#regionSearch").focus(), 0);
  });

  $("#regionSearch").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (!query) { $("#searchResults").innerHTML = ""; return; }
    if (!geoData) { $("#searchResults").innerHTML = "<p>行政区数据正在加载…</p>"; return; }
    const matches = geoData.features.filter((feature) => `${featureName(feature)} ${countryName(feature)} ${JSON.stringify(feature.properties)}`.toLowerCase().includes(query)).slice(0, 8);
    $("#searchResults").innerHTML = matches.map((feature) => `<button class="search-result" data-id="${feature.properties._id}">${escapeHtml(featureName(feature))}<small>${escapeHtml(countryName(feature))}</small></button>`).join("") || "<p>没有找到这个地区</p>";
  });

  $("#searchResults").addEventListener("click", (event) => {
    const button = event.target.closest("[data-id]"); if (!button) return;
    const feature = geoData.features.find((item) => String(item.properties._id) === button.dataset.id); if (!feature) return;
    const bounds = new maplibregl.LngLatBounds(); const addCoords = (coords) => typeof coords[0] === "number" ? bounds.extend(coords) : coords.forEach(addCoords);
    addCoords(feature.geometry.coordinates); map.fitBounds(bounds, { padding: 100, maxZoom: 5, duration: 1300 });
    map.setFilter("regions-highlight", ["==", ["get", "_id"], feature.properties._id]); $("#searchPopover").hidden = true;
    selectedFeature = feature; setTimeout(() => openRegionModal(feature), 500);
  });

  $("#inviteButton").addEventListener("click", () => currentUser ? openModal("inviteModal") : showAuthModal("登录后会自动生成你的专属邀请码。"));
  $("#accountButton").addEventListener("click", () => showAuthModal());
  $("#sendMagicLink").addEventListener("click", sendMagicLink);
  $("#signOutButton").addEventListener("click", async () => { await db?.auth.signOut(); closeModal("authModal"); showToast("已退出登录"); });
  $("#copyInvite").addEventListener("click", async () => {
    if (!currentProfile?.invite_code) { showAuthModal("登录后会自动生成你的专属邀请码。"); return; }
    try { await navigator.clipboard.writeText(currentProfile.invite_code); showToast("邀请码已复制"); }
    catch (_) { showToast(`邀请码：${currentProfile.invite_code}`); }
  });
  $("#joinButton").addEventListener("click", joinSharedMap);
  $("#mapSelector").addEventListener("change", async (event) => {
    activeMapId = event.target.value; sessionStorage.setItem("wanderbook-active-map", activeMapId); await loadRemoteRecords(); bindRealtime();
  });
  $("#openGallery").addEventListener("click", () => showToast(Object.values(records).some((record) => record.photos?.length) ? "照片已展示在最近的旅行记忆中" : "点亮去过的地区并上传第一张照片吧"));

  $$('[data-nav-action]').forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.navAction;
    $$('[data-nav-action]').forEach((item) => item.classList.toggle("active", item === button));
    if (action === "home" || action === "map") {
      map.flyTo({ center: [22, 25], zoom: .35, bearing: 0, pitch: 0, duration: 1200 });
      document.querySelector(".map-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (action === "planned") {
      const plannedFilter = $('.filter-pill[data-filter="planned"]');
      plannedFilter?.click();
      document.querySelector(".map-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (action === "list") {
      const allFilter = $('.filter-pill[data-filter="all"]');
      allFilter?.click();
      $("#searchPopover").hidden = false;
      $("#regionSearch").focus();
      return;
    }
    if (action === "memories") {
      document.querySelector(".memory-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
      $("#openGallery").click();
    }
  }));

  await initializeBackend();
function registerJournalHandlers() {
  const textarea = document.getElementById('journal');
 
function autosize() {
  if (!textarea) return;

  textarea.style.height = 'auto';
 
  textarea.style.height = (textarea.scrollHeight + 2) + 'px';
}


textarea.addEventListener('input', autosize, { passive: true });

autosize();
  const saveBtn = document.getElementById('save');
  if (!textarea || !saveBtn) return;

  async function loadJournal() {
    if (backendReady && currentUser) {
      try {
        const { data, error } = await db.from('journals').select('content, updated_at').eq('user_id', currentUser.id).single();
        if (!error && data?.content != null) {
          textarea.value = data.content;
          localStorage.setItem('journalContent', data.content);
          return;
        }
      } catch (e) {
      }
    }

    const saved = localStorage.getItem('journalContent');
    if (saved) textarea.value = saved;
  }

  async function saveJournal() {
    const content = textarea.value;
    try {
      localStorage.setItem('journalContent', content);

      if (backendReady && currentUser) {
        // Use upsert with a unique constraint on user_id (see SQL below)
        const payload = { user_id: currentUser.id, content, updated_at: new Date().toISOString() };
        const { error } = await db.from('journals').upsert(payload, { onConflict: 'user_id' });
        if (error) {
          showToast('云端保存失败，已保存在本地');
          return;
        }
        showToast('已保存到云端');
        return;
      }

      showToast('已保存在本地');
    } catch (err) {
      console.error(err);
      showToast('保存失败，请稍后重试');
    }
  }

  saveBtn.addEventListener('click', (e) => { e.preventDefault(); saveJournal(); });

  let autosaveTimer;
  textarea.addEventListener('input', () => {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveJournal, 1500);
  });

  loadJournal().catch((e) => console.error('loadJournal error', e));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', registerJournalHandlers);
} else {
  registerJournalHandlers();
}
});
})();
