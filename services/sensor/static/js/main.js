document.addEventListener("DOMContentLoaded", () => {
  let hasOverlay = true;
  let systemInfo = null;
  let ws = null;
  let pollInterval = null;
  let aiModel = null;
  let detectionLoopActive = false;

  // Waste Taxonomy Mapping for In-Browser AI Engine
  const WASTE_MAPPING = {
    "bottle": { name: "Plastic / Glass Bottle", category: "Bottle", recyclable: true, biodegradable: false, bin: "Blue Bin (Plastics/Glass)", color: "#06b6d4" },
    "wine glass": { name: "Glassware / Glass", category: "Glass", recyclable: true, biodegradable: false, bin: "Cyan Bin (Glass)", color: "#00e5ff" },
    "cup": { name: "Beverage Can / Cup", category: "Can / Cup", recyclable: true, biodegradable: false, bin: "Yellow Bin (Metals/Paper)", color: "#f59e0b" },
    "book": { name: "Paper / Cardboard Waste", category: "Paper", recyclable: true, biodegradable: true, bin: "Blue Bin (Paper/Dry)", color: "#3b82f6" },
    "banana": { name: "Banana Peel / Food Scrap", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "apple": { name: "Apple Scrap / Food Waste", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "orange": { name: "Orange Peel / Citrus", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "sandwich": { name: "Food Waste Scrap", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "pizza": { name: "Food Residue / Waste", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "donut": { name: "Food Scrap", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "cake": { name: "Food Scrap", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "carrot": { name: "Vegetable Peel", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "broccoli": { name: "Vegetable Scrap", category: "Organic Waste", recyclable: false, biodegradable: true, bin: "Green Bin (Compost)", color: "#10b981" },
    "bowl": { name: "Plastic / Ceramic Bowl", category: "Plastic / Ceramic", recyclable: true, biodegradable: false, bin: "Recyclable Bin", color: "#64748b" },
    "fork": { name: "Disposable Cutlery", category: "Plastic Cutlery", recyclable: true, biodegradable: false, bin: "Recyclables", color: "#f59e0b" },
    "knife": { name: "Disposable Cutlery", category: "Plastic Cutlery", recyclable: true, biodegradable: false, bin: "Recyclables", color: "#f59e0b" },
    "spoon": { name: "Disposable Cutlery", category: "Plastic Cutlery", recyclable: true, biodegradable: false, bin: "Recyclables", color: "#f59e0b" }
  };

  function resolveWasteClass(rawClass) {
    if (!rawClass) return null;
    const clean = rawClass.toLowerCase().trim();
    if (WASTE_MAPPING[clean]) return WASTE_MAPPING[clean];
    for (const k in WASTE_MAPPING) {
      if (clean.includes(k) || k.includes(clean)) return WASTE_MAPPING[k];
    }
    return null;
  }

  // Load in-browser AI model (TensorFlow.js COCO-SSD)
  const aiModelBadge = document.getElementById("ai-model-badge");
  const aiModelStatus = document.getElementById("ai-model-status");

  async function loadAIModel() {
    if (typeof cocoSsd === "undefined") {
      if (aiModelStatus) aiModelStatus.textContent = "AI: Cloud Mode";
      return;
    }
    try {
      if (aiModelStatus) aiModelStatus.textContent = "AI: Initializing Neural Net...";
      aiModel = await cocoSsd.load({ base: "mobilenet_v2" });
      if (aiModelStatus) aiModelStatus.textContent = "AI: Active (On-Device)";
      if (aiModelBadge) aiModelBadge.style.borderColor = "#10b981";
      console.log("In-browser AI Waste Detection Model ready!");
    } catch (err) {
      console.warn("Could not load local TFJS model, falling back to server:", err);
      if (aiModelStatus) aiModelStatus.textContent = "AI: Standby";
    }
  }
  loadAIModel();

  // Backend URL handling
  const serverConfig = window.DETECTION_CONFIG || window.DASHBOARD_CONFIG || {};
  const isStandaloneMode = Boolean(serverConfig.standalone);
  let backendUrl = localStorage.getItem("ecowing_backend_url") || "";
  
  if (!backendUrl) {
    if (!isStandaloneMode) {
      backendUrl = window.location.origin;
    } else {
      backendUrl = "";
    }
  }

  // DOM Elements
  const hostIpBadge = document.getElementById("host-ip-badge");
  const streamStatusBadge = document.getElementById("stream-status-badge");
  const streamStatusText = document.getElementById("stream-status-text");
  const bannerStatusTitle = document.getElementById("banner-status-title");
  const bannerStatusSub = document.getElementById("banner-status-sub");
  const inputBackendUrl = document.getElementById("input-backend-url");
  const btnConnectBackend = document.getElementById("btn-connect-backend");

  const streamImg = document.getElementById("stream-img");
  const deviceVideo = document.getElementById("device-video");
  const annotatedCanvas = document.getElementById("annotated-canvas");
  const tabModeCamera = document.getElementById("tab-mode-camera");
  const tabModeViewer = document.getElementById("tab-mode-viewer");
  const btnToggleCamera = document.getElementById("btn-toggle-camera");
  const liveCameraTag = document.getElementById("live-camera-tag");
  const targetWebsiteUrl = document.getElementById("target-website-url");
  const btnStartRelay = document.getElementById("btn-start-relay");

  const valTotal = document.getElementById("val-total");
  const valRec = document.getElementById("val-rec");
  const valNonRec = document.getElementById("val-non-rec");
  const valBio = document.getElementById("val-bio");
  const valNonBio = document.getElementById("val-non-bio");
  const subRec = document.getElementById("sub-rec");
  const livePillCount = document.getElementById("live-pill-count");
  const detectedItemsContainer = document.getElementById("detected-items-container");

  const inputStreamUrl = document.getElementById("input-stream-url");
  const inputApiUrl = document.getElementById("input-api-url");
  const inputMobileUrl = document.getElementById("input-mobile-url");
  const qrCodeImg = document.getElementById("qr-code-img");
  const codeHtml = document.getElementById("code-html");
  const codeReact = document.getElementById("code-react");
  const codeJs = document.getElementById("code-js");

  const confSlider = document.getElementById("conf-slider");
  const confVal = document.getElementById("conf-val");
  const currentSourceTag = document.getElementById("current-source-tag");
  const btnFullscreen = document.getElementById("btn-fullscreen");
  const videoWrapper = document.getElementById("video-wrapper");

  let localStream = null;
  let isCameraActive = false;
  let isRelaying = false;
  let relayInterval = null;
  let relayTarget = localStorage.getItem("ecowing_target_website") || "http://localhost:3000";
  let lastRelayDetectionTime = 0;

  if (targetWebsiteUrl) targetWebsiteUrl.value = relayTarget;
  if (inputBackendUrl) inputBackendUrl.value = backendUrl;

  // Initialize Canvas View
  const initialCtx = annotatedCanvas.getContext("2d");
  annotatedCanvas.width = 640;
  annotatedCanvas.height = 480;
  initialCtx.fillStyle = "#0b0f14";
  initialCtx.fillRect(0, 0, 640, 480);
  initialCtx.fillStyle = "#10b981";
  initialCtx.font = "bold 18px Plus Jakarta Sans, sans-serif";
  initialCtx.textAlign = "center";
  initialCtx.fillText("ECOWING AI WASTE DETECTOR", 320, 230);
  initialCtx.fillStyle = "#8b949e";
  initialCtx.font = "14px Plus Jakarta Sans, sans-serif";
  initialCtx.fillText("Click 'Start Camera' above to begin AI waste classification", 320, 260);

  // Mode Switchers
  tabModeCamera.addEventListener("click", () => {
    tabModeCamera.classList.add("active", "btn-primary");
    tabModeCamera.classList.remove("btn-secondary");
    tabModeViewer.classList.remove("active", "btn-primary");
    tabModeViewer.classList.add("btn-secondary");

    annotatedCanvas.style.display = "block";
    streamImg.style.display = "none";
    liveCameraTag.textContent = isCameraActive ? "AI WASTE DETECTOR LIVE" : "AI DETECTOR STANDBY";
  });

  tabModeViewer.addEventListener("click", () => {
    tabModeViewer.classList.add("active", "btn-primary");
    tabModeViewer.classList.remove("btn-secondary");
    tabModeCamera.classList.remove("active", "btn-primary");
    tabModeCamera.classList.add("btn-secondary");

    annotatedCanvas.style.display = "none";
    streamImg.style.display = "block";
    liveCameraTag.textContent = "AI STREAM VIEWER";
  });

  // Start / Stop Device Camera
  async function toggleDeviceCamera() {
    if (isCameraActive) {
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      deviceVideo.srcObject = null;
      isCameraActive = false;
      detectionLoopActive = false;

      btnToggleCamera.textContent = "Start Camera";
      btnToggleCamera.style.background = "rgba(16, 185, 129, 0.2)";
      btnToggleCamera.style.borderColor = "#10b981";
      btnToggleCamera.style.color = "#10b981";
      currentSourceTag.textContent = "Camera: Offline";
      liveCameraTag.textContent = "DEVICE CAMERA OFFLINE";
      if (isRelaying) stopRelaying();
    } else {
      try {
        btnToggleCamera.textContent = "Starting...";
        const constraints = {
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: "environment"
          },
          audio: false
        };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        deviceVideo.srcObject = localStream;
        await deviceVideo.play();

        isCameraActive = true;
        detectionLoopActive = true;

        btnToggleCamera.textContent = "Stop Camera";
        btnToggleCamera.style.background = "rgba(239, 68, 68, 0.2)";
        btnToggleCamera.style.borderColor = "#ef4444";
        btnToggleCamera.style.color = "#ef4444";
        currentSourceTag.textContent = "Camera: Device Live";
        liveCameraTag.textContent = "AI DETECTING WASTE...";

        // Start real-time AI detection loop
        runRealtimeDetection();
      } catch (err) {
        btnToggleCamera.textContent = "Start Camera";
        alert("Camera error: " + err.message);
      }
    }
  }
  btnToggleCamera.addEventListener("click", toggleDeviceCamera);

  // Real-Time In-Browser AI Waste Detection Loop
  async function runRealtimeDetection() {
    if (!detectionLoopActive || !isCameraActive) return;

    if (deviceVideo.readyState === 4) {
      const w = deviceVideo.videoWidth || 640;
      const h = deviceVideo.videoHeight || 480;

      if (annotatedCanvas.width !== w || annotatedCanvas.height !== h) {
        annotatedCanvas.width = w;
        annotatedCanvas.height = h;
      }

      const ctx = annotatedCanvas.getContext("2d");
      ctx.drawImage(deviceVideo, 0, 0, w, h);

      if (aiModel) {
        try {
          const predictions = await aiModel.detect(deviceVideo);
          const minConf = (parseFloat(confSlider.value) || 35) / 100.0;
          let wasteItems = [];
          let recCount = 0;
          let bioCount = 0;

          predictions.forEach(pred => {
            const taxonomy = resolveWasteClass(pred.class);
            // Strictly show WASTE items only!
            if (!taxonomy || pred.score < minConf) return;

            const [bx, by, bw, bh] = pred.bbox;
            const confPct = Math.round(pred.score * 100);

            if (taxonomy.recyclable) recCount++;
            if (taxonomy.biodegradable) bioCount++;

            wasteItems.push({
              name: taxonomy.name,
              category: taxonomy.category,
              confidence: confPct,
              recyclable: taxonomy.recyclable,
              biodegradable: taxonomy.biodegradable,
              bin: taxonomy.bin,
              bbox: [bx, by, bx + bw, by + bh]
            });

            // Draw bounding box
            ctx.strokeStyle = taxonomy.color;
            ctx.lineWidth = 3;
            ctx.strokeRect(bx, by, bw, bh);

            // Corner accents
            const clen = Math.min(20, bw / 4, bh / 4);
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(bx, by + clen); ctx.lineTo(bx, by); ctx.lineTo(bx + clen, by);
            ctx.moveTo(bx + bw - clen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + clen);
            ctx.moveTo(bx, by + bh - clen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + clen, by + bh);
            ctx.moveTo(bx + bw - clen, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - clen);
            ctx.stroke();

            // Header text badge
            ctx.fillStyle = taxonomy.color;
            const label = `${taxonomy.name} ${confPct}%`;
            ctx.font = "bold 13px 'Plus Jakarta Sans', sans-serif";
            const textWidth = ctx.measureText(label).width;
            const badgeY = Math.max(by - 26, 6);
            ctx.fillRect(bx, badgeY, Math.max(textWidth + 14, 180), 22);

            ctx.fillStyle = "#000000";
            ctx.fillText(label, bx + 6, badgeY + 16);

            // Sub pills (Recyclable & Biodegradable)
            const subY = badgeY + 24;
            ctx.fillStyle = taxonomy.recyclable ? "#10b981" : "#ef4444";
            ctx.fillRect(bx, subY, 82, 16);
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 10px 'Plus Jakarta Sans', sans-serif";
            ctx.fillText(taxonomy.recyclable ? "REC: YES" : "REC: NO", bx + 6, subY + 12);

            ctx.fillStyle = taxonomy.biodegradable ? "#34d399" : "#64748b";
            ctx.fillRect(bx + 86, subY, 82, 16);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(taxonomy.biodegradable ? "BIO: YES" : "BIO: NO", bx + 92, subY + 12);
          });

          // Draw Top HUD on canvas
          ctx.fillStyle = "rgba(18, 22, 28, 0.85)";
          ctx.fillRect(0, 0, w, 38);
          ctx.fillStyle = "#10b981";
          ctx.font = "bold 14px 'Plus Jakarta Sans', sans-serif";
          ctx.textAlign = "left";
          ctx.fillText("ECOWING AI WASTE SORTER", 14, 24);
          ctx.fillStyle = "#ffffff";
          ctx.font = "12px 'Plus Jakarta Sans', sans-serif";
          ctx.fillText(`WASTE: ${wasteItems.length} | RECYCLABLE: ${recCount} | BIO: ${bioCount}`, 240, 24);

          // Update metrics cards on web page
          updateTelemetry({
            total_count: wasteItems.length,
            recyclable_count: recCount,
            non_recyclable_count: wasteItems.length - recCount,
            biodegradable_count: bioCount,
            non_biodegradable_count: wasteItems.length - bioCount,
            items: wasteItems
          });

          // Automatically persist detections into EcoWing database (throttled to 1/sec)
          if (wasteItems.length > 0) {
            const now = Date.now();
            if (now - lastRelayDetectionTime > 1200) {
              lastRelayDetectionTime = now;
              const top = wasteItems[0];
              const endpoint = (relayTarget || "http://localhost:3000").replace(/\/$/, "");
              fetch(`${endpoint}/api/drone/detection`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  drone_id: "Device Webcam",
                  class_name: top.name,
                  material_type: top.recyclable ? "Recyclable" : (top.biodegradable ? "Biodegradable" : "Non-Recyclable"),
                  confidence: Number((top.confidence / 100).toFixed(2)),
                  center: [320, 240]
                })
              }).catch(() => {});
            }
          }
        } catch (e) {
          console.error("AI detection error:", e);
        }
      }
    }

    requestAnimationFrame(runRealtimeDetection);
  }

  // Stream Relayer: Pushes annotated frame with bounding boxes to other website
  function startRelaying() {
    const rawTarget = targetWebsiteUrl.value.trim();
    if (!rawTarget) {
      alert("Please enter the destination website URL (e.g. http://localhost:3000 or your EcoWing website link)");
      return;
    }

    if (!isCameraActive) {
      alert("Please click 'Start Camera' first before streaming!");
      return;
    }

    relayTarget = rawTarget.replace(/\/$/, "");
    localStorage.setItem("ecowing_target_website", relayTarget);

    isRelaying = true;
    btnStartRelay.textContent = "⏹️ Stop Streaming to Website";
    btnStartRelay.classList.remove("btn-primary");
    btnStartRelay.style.background = "#ef4444";
    liveCameraTag.textContent = "STREAMING LIVE TO: " + relayTarget;

    // Push frames at ~18 FPS
    relayInterval = setInterval(() => {
      if (!isRelaying || !isCameraActive || annotatedCanvas.width === 0) return;

      const dataUrl = annotatedCanvas.toDataURL("image/jpeg", 0.72);
      fetch(`${relayTarget}/api/drone/stream-frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame: dataUrl })
      }).catch(() => {});
    }, 55);
  }

  function stopRelaying() {
    isRelaying = false;
    if (relayInterval) {
      clearInterval(relayInterval);
      relayInterval = null;
    }
    btnStartRelay.textContent = "🔴 Stream to Other Website";
    btnStartRelay.style.background = "";
    btnStartRelay.classList.add("btn-primary");
    liveCameraTag.textContent = isCameraActive ? "AI WASTE DETECTOR LIVE" : "AI DETECTOR STANDBY";
  }

  btnStartRelay.addEventListener("click", () => {
    if (isRelaying) stopRelaying();
    else startRelaying();
  });

  // Backend URL handling
  function setBackend(url) {
    if (!url) return;
    url = url.trim().replace(/\/$/, "");

    if (window.location.protocol === "https:" && url.startsWith("http://")) {
      alert("⚠️ Mixed Content Warning:\n\nBecause this page is on HTTPS, browsers block unencrypted 'http://' streams.\n\nPlease either:\n1. Use a secure HTTPS tunnel (double-click 'start_tunnel.bat' to get https://...loca.lt)\n2. OR open the local dashboard directly at http://localhost:5000");
    }

    backendUrl = url;
    localStorage.setItem("ecowing_backend_url", backendUrl);
    if (inputBackendUrl) inputBackendUrl.value = backendUrl;

    bannerStatusTitle.textContent = "Connected to " + backendUrl;
    bannerStatusSub.textContent = "Loading stream and telemetry...";

    streamImg.src = `${backendUrl}/video_feed?overlay=${hasOverlay}&t=${Date.now()}`;
    loadSystemInfo();
    initWebSocket();
  }

  btnConnectBackend.addEventListener("click", () => {
    const val = inputBackendUrl.value.trim();
    if (!val) return alert("Please enter a valid stream URL");
    setBackend(val);
  });

  hostIpBadge.addEventListener("click", () => {
    const val = prompt("Enter your AI Detection Server or Tunnel URL:", backendUrl || "https://your-tunnel.loca.lt");
    if (val) setBackend(val);
  });

  // Load System Info
  async function loadSystemInfo() {
    const targetUrl = backendUrl ? `${backendUrl}/api/system_info` : "/api/system_info";
    try {
      const res = await fetch(targetUrl);
      if (!res.ok) throw new Error("Offline");
      systemInfo = await res.json();
      
      const ip = systemInfo.local_ip || window.location.hostname;
      const port = systemInfo.port || window.location.port || "5000";
      const base = backendUrl || `http://${ip}:${port}`;
      const streamUrl = `${base}/video_feed`;
      const apiUrl = `${base}/api/detections`;
      const mobileUrl = `${base}/mobile`;

      hostIpBadge.textContent = `Backend: ${base.replace(/^https?:\/\//, '')}`;
      bannerStatusTitle.textContent = "Stream Connected: " + base;
      bannerStatusSub.textContent = "Dual Classification Active";
      streamStatusText.textContent = "LIVE STREAMING";

      inputStreamUrl.value = streamUrl;
      inputApiUrl.value = apiUrl;
      if (inputMobileUrl) inputMobileUrl.value = mobileUrl;
      if (qrCodeImg) {
        qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(mobileUrl)}`;
        qrCodeImg.classList.remove("hidden");
      }

      codeHtml.textContent = `<img src="${streamUrl}" alt="EcoWing Stream" style="width: 100%; border-radius: 12px;" />`;
      codeReact.textContent = `<img src="${streamUrl}" alt="EcoWing Stream" className="w-full rounded-2xl" />`;
      codeJs.textContent = `fetch("${apiUrl}").then(r => r.json()).then(d => console.log(d.data.items));`;
    } catch (err) {
      if (isStandaloneMode || !backendUrl) {
        bannerStatusTitle.textContent = "On-Device AI Active";
        bannerStatusSub.textContent = "Using in-browser AI engine (click 'Start Camera' to begin)";
        streamStatusText.textContent = "LOCAL AI READY";
      }
    }
  }

  let activeWasteFilter = "all";
  let lastReceivedTelemetry = null;

  function getWasteIcon(name) {
    const n = (name || "").toLowerCase();
    if (n.includes("bottle")) return "🍾";
    if (n.includes("cup") || n.includes("can") || n.includes("tin")) return "🥫";
    if (n.includes("organic") || n.includes("fruit") || n.includes("food") || n.includes("banana") || n.includes("apple")) return "🍎";
    if (n.includes("paper") || n.includes("cardboard") || n.includes("book")) return "📄";
    if (n.includes("glass")) return "🪟";
    if (n.includes("bag") || n.includes("plastic")) return "🛍️";
    return "🗑️";
  }

  function renderFilteredItems() {
    if (!detectedItemsContainer) return;
    if (!lastReceivedTelemetry || !lastReceivedTelemetry.items || lastReceivedTelemetry.items.length === 0) {
      detectedItemsContainer.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🔍</span>
          <p>No waste items in view</p>
          <small>Point camera at plastic, paper, glass, can, cardboard, or food waste</small>
        </div>
      `;
      return;
    }

    const filtered = lastReceivedTelemetry.items.filter(item => {
      if (activeWasteFilter === "recyclable") return item.recyclable === true;
      if (activeWasteFilter === "non-recyclable") return item.recyclable === false;
      if (activeWasteFilter === "biodegradable") return item.biodegradable === true;
      return true; // "all"
    });

    if (filtered.length === 0) {
      detectedItemsContainer.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🔎</span>
          <p>No items matching '${activeWasteFilter}' filter</p>
          <small>Select 'All' to view all active detections</small>
        </div>
      `;
      return;
    }

    let html = "";
    filtered.forEach(item => {
      const icon = getWasteIcon(item.name);
      const recClass = item.recyclable ? "tag-rec-yes" : "tag-rec-no";
      const recText = item.recyclable ? "Recyclable" : "Non-Rec";
      const bioClass = item.biodegradable ? "tag-bio-yes" : "tag-bio-no";
      const bioText = item.biodegradable ? "Bio" : "Non-Bio";
      const conf = Math.round(item.confidence || 0);

      html += `
        <div class="item-badge">
          <div class="item-main">
            <span class="item-title">${icon} ${item.name}</span>
            <span class="item-bin">Disposal: <strong>${item.bin || 'General'}</strong></span>
            <div class="conf-bar-wrap" title="Confidence: ${conf}%">
              <div class="conf-bar-fill" style="width: ${conf}%;"></div>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
            <div class="item-tags">
              <span class="tag ${recClass}">${recText}</span>
              <span class="tag ${bioClass}">${bioText}</span>
            </div>
            <span style="font-family: var(--font-mono); font-size: 10px; font-weight: 700; color: #38bdf8;">${conf}%</span>
          </div>
        </div>
      `;
    });
    detectedItemsContainer.innerHTML = html;
  }

  // Update telemetry metrics cards
  function updateTelemetry(data) {
    if (!data) return;
    lastReceivedTelemetry = data;

    const total = data.total_count || 0;
    const rec = data.recyclable_count || 0;
    const nonRec = data.non_recyclable_count || 0;
    const bio = data.biodegradable_count || 0;
    const nonBio = data.non_biodegradable_count || 0;

    valTotal.textContent = total;
    valRec.textContent = rec;
    valNonRec.textContent = nonRec;
    valBio.textContent = bio;
    valNonBio.textContent = nonBio;

    const pct = total > 0 ? Math.round((rec / total) * 100) : 0;
    subRec.textContent = `${pct}% of detected`;
    livePillCount.textContent = `${total} Detected`;

    renderFilteredItems();
  }

  // WebSocket Connection
  function initWebSocket() {
    if (ws) {
      try { ws.close(); } catch(e) {}
      ws = null;
    }

    const target = backendUrl || window.location.origin;
    const cleanHost = target.replace(/^https?:\/\//, '');
    const isHttps = target.startsWith("https:") || window.location.protocol === "https:";
    const proto = isHttps ? "wss:" : "ws:";
    const wsUrl = `${proto}//${cleanHost}/ws`;

    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "telemetry" && !isCameraActive) {
            updateTelemetry(payload.summary);
          }
        } catch (e) {}
      };
      ws.onerror = () => startPolling();
      ws.onclose = () => startPolling();
    } catch (e) {
      startPolling();
    }
  }

  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      if (isCameraActive) return; // In camera mode, local AI handles telemetry
      const target = backendUrl ? `${backendUrl}/api/detections` : "/api/detections";
      try {
        const res = await fetch(target);
        const json = await res.json();
        if (json.status === "success") {
          updateTelemetry(json.data);
          streamStatusText.textContent = "LIVE STREAMING";
        }
      } catch (e) {}
    }, 1000);
  }

  // Fullscreen
  btnFullscreen.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      videoWrapper.requestFullscreen().catch(err => alert(err.message));
    } else {
      document.exitFullscreen();
    }
  });

  // Confidence Slider
  confSlider.addEventListener("input", (e) => {
    confVal.textContent = `${e.target.value}%`;
  });

  confSlider.addEventListener("change", async (e) => {
    const threshold = parseFloat(e.target.value) / 100;
    const headers = { "Content-Type": "application/json" };
    if (operatorToken) headers["X-Operator-Token"] = operatorToken;
    try {
      const target = backendUrl ? `${backendUrl}/api/settings` : "/api/settings";
      await fetch(target, {
        method: "POST",
        headers,
        body: JSON.stringify({ confidence_threshold: threshold })
      });
    } catch (err) {}
  });

  // Operator Token Authentication
  let operatorToken = sessionStorage.getItem("ecowing_operator_token") || "";
  const inputOperatorToken = document.getElementById("input-operator-token");
  const btnSaveOperatorToken = document.getElementById("btn-save-operator-token");
  const operatorTokenStatus = document.getElementById("operator-token-status");

  function updateTokenStatusUI() {
    if (!operatorTokenStatus) return;
    if (operatorToken) {
      operatorTokenStatus.textContent = "✓ Token Active (Session)";
      operatorTokenStatus.style.color = "#10b981";
    } else {
      operatorTokenStatus.textContent = "No Token Set";
      operatorTokenStatus.style.color = "#ef4444";
    }
  }
  updateTokenStatusUI();

  if (btnSaveOperatorToken && inputOperatorToken) {
    btnSaveOperatorToken.addEventListener("click", () => {
      const val = inputOperatorToken.value.trim();
      if (!val) {
        alert("Please enter a valid operator token.");
        return;
      }
      operatorToken = val;
      sessionStorage.setItem("ecowing_operator_token", operatorToken);
      inputOperatorToken.value = "";
      updateTokenStatusUI();
    });
  }

  // Video Input Source Controls
  const sourceSelect = document.getElementById("source-select");
  const btnApplySource = document.getElementById("btn-apply-source");
  const customSourceRow = document.getElementById("custom-source-row");
  const customSourceInput = document.getElementById("custom-source-input");
  const settingsStatusMsg = document.getElementById("settings-status-msg");

  if (sourceSelect) {
    sourceSelect.addEventListener("change", () => {
      if (sourceSelect.value === "custom") {
        if (customSourceRow) customSourceRow.classList.remove("hidden");
      } else {
        if (customSourceRow) customSourceRow.classList.add("hidden");
      }
    });
  }

  if (btnApplySource) {
    btnApplySource.addEventListener("click", async () => {
      let srcVal = sourceSelect ? sourceSelect.value : "simulator";
      if (srcVal === "custom") {
        srcVal = customSourceInput ? customSourceInput.value.trim() : "";
      } else if (srcVal === "0" || srcVal === "1") {
        srcVal = parseInt(srcVal, 10);
      }
      if (!srcVal && srcVal !== 0) {
        if (settingsStatusMsg) {
          settingsStatusMsg.textContent = "Please provide a valid source.";
          settingsStatusMsg.style.color = "#ef4444";
        }
        return;
      }

      const headers = { "Content-Type": "application/json" };
      if (operatorToken) headers["X-Operator-Token"] = operatorToken;

      try {
        const target = backendUrl ? `${backendUrl}/api/settings` : "/api/settings";
        const res = await fetch(target, {
          method: "POST",
          headers,
          body: JSON.stringify({ video_source: srcVal })
        });
        const data = await res.json();
        if (res.ok) {
          if (settingsStatusMsg) {
            settingsStatusMsg.textContent = `✓ Source updated to: ${data.settings.video_source}`;
            settingsStatusMsg.style.color = "#10b981";
          }
        } else {
          if (settingsStatusMsg) {
            settingsStatusMsg.textContent = `⚠️ Error: ${data.detail || "Update failed (Operator Token required)"}`;
            settingsStatusMsg.style.color = "#ef4444";
          }
        }
      } catch (e) {
        if (settingsStatusMsg) {
          settingsStatusMsg.textContent = `⚠️ Connection error: ${e.message}`;
          settingsStatusMsg.style.color = "#ef4444";
        }
      }
    });
  }

  // Mobile Pairing Code Generation
  const btnGenPairingCode = document.getElementById("btn-gen-pairing-code");
  const pairingCodeDisplay = document.getElementById("pairing-code-display");

  if (btnGenPairingCode && pairingCodeDisplay) {
    btnGenPairingCode.addEventListener("click", async () => {
      const headers = {};
      if (operatorToken) headers["X-Operator-Token"] = operatorToken;

      pairingCodeDisplay.textContent = "Generating...";
      pairingCodeDisplay.style.color = "#94a3b8";

      try {
        const target = backendUrl ? `${backendUrl}/api/mobile/pairing_code` : "/api/mobile/pairing_code";
        const res = await fetch(target, { method: "POST", headers });
        const data = await res.json();
        if (res.ok) {
          pairingCodeDisplay.innerHTML = `Pairing Code: <span style="font-family: monospace; font-size: 16px; color: #10b981; letter-spacing: 2px;">${data.pairing_code}</span> (Valid ${data.expires_in}s)`;
        } else {
          pairingCodeDisplay.textContent = data.detail || "Failed to generate pairing code. Operator Token required.";
          pairingCodeDisplay.style.color = "#ef4444";
        }
      } catch (e) {
        pairingCodeDisplay.textContent = "Error: " + e.message;
        pairingCodeDisplay.style.color = "#ef4444";
      }
    });
  }

  // Instant Snapshot / Dropzone Upload
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const uploadResult = document.getElementById("upload-result");

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("dragover");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFileUpload(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFileUpload(e.target.files[0]);
      }
    });
  }

  async function handleFileUpload(file) {
    if (!file || !uploadResult) return;
    uploadResult.classList.remove("hidden");
    uploadResult.innerHTML = "<p style='color: var(--text-muted); padding: 8px;'>Analyzing image with YOLO waste model...</p>";

    const formData = new FormData();
    formData.append("file", file);

    const headers = {};
    if (operatorToken) headers["X-Operator-Token"] = operatorToken;

    try {
      const target = backendUrl ? `${backendUrl}/api/upload` : "/api/upload";
      const res = await fetch(target, {
        method: "POST",
        headers,
        body: formData
      });
      const data = await res.json();

      if (res.ok && data.status === "success") {
        const ana = data.analysis;
        let itemsHtml = "";
        if (ana.items && ana.items.length > 0) {
          itemsHtml = ana.items.map(it => `
            <div style="padding: 6px 10px; background: rgba(255,255,255,0.05); border-radius: 6px; margin-top: 4px; display: flex; justify-content: space-between; align-items: center;">
              <span><strong>${it.name || it.class_id}</strong> (${Math.round((it.confidence || 0) * 100)}%)</span>
              <span style="font-size: 11px; color: ${it.recyclable === 'yes' || it.recyclable === true ? '#10b981' : '#f59e0b'};">${it.category || ''}</span>
            </div>
          `).join("");
        } else {
          itemsHtml = "<p style='font-size: 12px; color: var(--text-muted);'>No waste objects detected in this snapshot.</p>";
        }

        uploadResult.innerHTML = `
          <div style="margin-bottom: 8px; padding: 10px; background: rgba(0,0,0,0.3); border-radius: 8px;">
            ${data.image_base64 ? `<img src="${data.image_base64}" style="width: 100%; max-height: 240px; object-fit: contain; border-radius: 8px; margin-bottom: 8px;" />` : ''}
            <div style="font-weight: 700; color: #10b981;">✓ Detection Complete: ${ana.total_count || 0} items found</div>
            <div style="font-size: 11px; color: var(--text-muted);">Recyclable: ${ana.recyclable_count || 0} | Biodegradable: ${ana.biodegradable_count || 0}</div>
            <div style="margin-top: 6px;">${itemsHtml}</div>
          </div>
        `;
      } else {
        uploadResult.innerHTML = `
          <div style="color: #ef4444; font-size: 12px; padding: 8px;">
            ⚠️ Upload error: ${data.detail || "Analysis failed. Please verify Operator Token."}
          </div>
        `;
      }
    } catch (e) {
      uploadResult.innerHTML = `<div style="color: #ef4444; font-size: 12px; padding: 8px;">⚠️ Upload error: ${e.message}</div>`;
    }
  }

  // Snippet Tabs
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      const el = document.getElementById(targetId);
      if (el) el.classList.add("active");
    });
  });

  // Copy helper
  window.copyText = function(elementId, isCode = false) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = isCode ? el.innerText : el.value;
    navigator.clipboard.writeText(text).then(() => {
      const activeBtn = document.activeElement;
      if (activeBtn && activeBtn.classList && activeBtn.classList.contains("btn")) {
        const orig = activeBtn.textContent;
        activeBtn.textContent = "✓ Copied!";
        setTimeout(() => { activeBtn.textContent = orig; }, 1800);
      }
    }).catch(err => {
      console.error("Copy failed", err);
    });
  };


  // Category Quick-Filter Bar
  const filterChips = document.querySelectorAll(".filter-chip");
  filterChips.forEach(chip => {
    chip.addEventListener("click", () => {
      filterChips.forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      activeWasteFilter = chip.getAttribute("data-filter") || "all";
      renderFilteredItems();
    });
  });

  // HUD Snapshot Capture & Download
  const btnHudSnapshot = document.getElementById("btn-hud-snapshot");
  if (btnHudSnapshot) {
    btnHudSnapshot.addEventListener("click", () => {
      const snapCanvas = document.createElement("canvas");
      const ctx = snapCanvas.getContext("2d");
      let sourceWidth = 640;
      let sourceHeight = 480;

      const isViewer = tabModeViewer && tabModeViewer.classList.contains("active");
      const srcEl = isViewer ? streamImg : annotatedCanvas;

      if (srcEl && (srcEl.videoWidth || srcEl.naturalWidth || srcEl.width)) {
        sourceWidth = srcEl.videoWidth || srcEl.naturalWidth || srcEl.width;
        sourceHeight = srcEl.videoHeight || srcEl.naturalHeight || srcEl.height;
      }
      snapCanvas.width = sourceWidth;
      snapCanvas.height = sourceHeight;

      if (srcEl) {
        try {
          ctx.drawImage(srcEl, 0, 0, sourceWidth, sourceHeight);
        } catch (e) {
          console.warn("Snapshot drawImage error (possible CORS):", e);
        }
      }

      // Sleek Tactical HUD Watermark Banner
      ctx.fillStyle = "rgba(7, 10, 14, 0.85)";
      ctx.fillRect(0, sourceHeight - 40, sourceWidth, 40);
      ctx.fillStyle = "#10b981";
      ctx.font = "bold 13px 'JetBrains Mono', monospace";
      ctx.fillText("ECOWING AERIAL RECON | WASTE SCANNER", 16, sourceHeight - 16);

      const dStr = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
      ctx.fillStyle = "#94a3b8";
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.fillText(`TIMESTAMP: ${dStr} UTC | CONF: ${confSlider ? confSlider.value : 35}%`, sourceWidth - 300, sourceHeight - 16);

      snapCanvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `ecowing-recon-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const origHtml = btnHudSnapshot.innerHTML;
        btnHudSnapshot.innerHTML = "<span>✓</span> Saved!";
        setTimeout(() => { btnHudSnapshot.innerHTML = origHtml; }, 1800);
      }, "image/png");
    });
  }

  // Tactical HUD Reticle Toggle
  const btnHudReticle = document.getElementById("btn-hud-reticle");
  const hudCrosshair = document.getElementById("hud-crosshair");
  if (btnHudReticle && hudCrosshair) {
    btnHudReticle.addEventListener("click", () => {
      const isHidden = hudCrosshair.style.display === "none";
      hudCrosshair.style.display = isHidden ? "block" : "none";
      btnHudReticle.classList.toggle("active", isHidden);
    });
  }

  // Night Vision / FLIR Thermal Tactical Mode
  const btnHudNight = document.getElementById("btn-hud-night");
  if (btnHudNight && videoWrapper) {
    btnHudNight.addEventListener("click", () => {
      videoWrapper.classList.toggle("night-vision");
      btnHudNight.classList.toggle("active");
    });
  }

  // Quick Test Sample Waste Chips
  const sampleChips = document.querySelectorAll(".sample-chip");
  sampleChips.forEach(chip => {
    chip.addEventListener("click", async () => {
      const sampleUrl = chip.getAttribute("data-sample");
      if (!sampleUrl) return;

      if (uploadResult) {
        uploadResult.classList.remove("hidden");
        uploadResult.innerHTML = `
          <div style="padding: 12px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; color: #10b981; font-size: 12px; display: flex; align-items: center; gap: 8px;">
            <span class="pulse-dot"></span> Analyzing ${chip.innerText.trim()} with AI Waste Model...
          </div>
        `;
      }

      try {
        const resp = await fetch(sampleUrl);
        if (!resp.ok) throw new Error("Could not load sample image: " + resp.statusText);
        const blob = await resp.blob();
        const filename = sampleUrl.substring(sampleUrl.lastIndexOf("/") + 1);
        const file = new File([blob], filename, { type: "image/jpeg" });
        uploadFile(file);
      } catch (err) {
        if (uploadResult) {
          uploadResult.innerHTML = `<div style="color: #ef4444; font-size: 12px; padding: 8px;">⚠️ Sample load error: ${err.message}</div>`;
        }
      }
    });
  });

  // Live flight HUD telemetry simulation (realistic drone telemetry variations)
  const hudAltVal = document.getElementById("hud-alt-val");
  const hudSpdVal = document.getElementById("hud-spd-val");
  const hudFpsVal = document.getElementById("hud-fps-val");
  setInterval(() => {
    if (hudAltVal) {
      hudAltVal.textContent = (28.2 + Math.random() * 0.6).toFixed(1) + "m";
    }
    if (hudSpdVal) {
      hudSpdVal.textContent = (7.0 + Math.random() * 0.4).toFixed(1) + " m/s";
    }
    if (hudFpsVal) {
      hudFpsVal.textContent = String(29 + Math.floor(Math.random() * 2));
    }
  }, 1800);

  // Init
  if (backendUrl) setBackend(backendUrl);
  else loadSystemInfo();
});
