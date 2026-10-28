document.addEventListener("DOMContentLoaded", () => {
  let hasOverlay = true;
  let systemInfo = null;
  let ws = null;
  let pollInterval = null;

  // Backend URL handling (supports local, LAN IP, and public tunnels on Vercel)
  const isVercel = window.location.hostname.includes("vercel.app");
  let backendUrl = localStorage.getItem("ecowing_backend_url") || "";
  
  if (!backendUrl) {
    if (!isVercel) {
      backendUrl = window.location.origin;
    } else {
      backendUrl = ""; // Needs user to connect tunnel
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
  const sourceSelect = document.getElementById("source-select");
  const btnApplySource = document.getElementById("btn-apply-source");
  const customSourceRow = document.getElementById("custom-source-row");
  const customSourceInput = document.getElementById("custom-source-input");
  const currentSourceTag = document.getElementById("current-source-tag");

  const btnToggleOverlay = document.getElementById("btn-toggle-overlay");
  const btnFullscreen = document.getElementById("btn-fullscreen");
  const videoWrapper = document.getElementById("video-wrapper");

  // Device Camera & Relayer Elements
  const deviceVideo = document.getElementById("device-video");
  const deviceCanvas = document.getElementById("device-canvas");
  const tabModeCamera = document.getElementById("tab-mode-camera");
  const tabModeViewer = document.getElementById("tab-mode-viewer");
  const btnToggleCamera = document.getElementById("btn-toggle-camera");
  const liveCameraTag = document.getElementById("live-camera-tag");
  const targetWebsiteUrl = document.getElementById("target-website-url");
  const btnStartRelay = document.getElementById("btn-start-relay");

  let localStream = null;
  let isCameraActive = false;
  let isRelaying = false;
  let relayInterval = null;
  let relayTarget = localStorage.getItem("ecowing_target_website") || "http://localhost:3000";

  if (targetWebsiteUrl) {
    targetWebsiteUrl.value = relayTarget;
  }

  // Camera Mode vs Viewer Mode Switching
  tabModeCamera.addEventListener("click", () => {
    tabModeCamera.classList.add("active", "btn-primary");
    tabModeCamera.classList.remove("btn-secondary");
    tabModeViewer.classList.remove("active", "btn-primary");
    tabModeViewer.classList.add("btn-secondary");

    deviceVideo.style.display = "block";
    streamImg.style.display = "none";
    liveCameraTag.textContent = isCameraActive ? "DEVICE CAMERA ACTIVE" : "DEVICE CAMERA STANDBY";
  });

  tabModeViewer.addEventListener("click", () => {
    tabModeViewer.classList.add("active", "btn-primary");
    tabModeViewer.classList.remove("btn-secondary");
    tabModeCamera.classList.remove("active", "btn-primary");
    tabModeCamera.classList.add("btn-secondary");

    deviceVideo.style.display = "none";
    streamImg.style.display = "block";
    liveCameraTag.textContent = "AI STREAM VIEWER";
  });

  // Start / Stop Local Device Camera (Webcam / Mobile Camera)
  async function toggleDeviceCamera() {
    if (isCameraActive) {
      // Stop Camera
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      deviceVideo.srcObject = null;
      isCameraActive = false;
      btnToggleCamera.textContent = "Start Camera";
      btnToggleCamera.style.background = "rgba(16, 185, 129, 0.2)";
      currentSourceTag.textContent = "Camera: Offline";
      liveCameraTag.textContent = "DEVICE CAMERA OFFLINE";
      if (isRelaying) stopRelaying();
    } else {
      // Start Camera
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
        isCameraActive = true;
        btnToggleCamera.textContent = "Stop Camera";
        btnToggleCamera.style.background = "rgba(239, 68, 68, 0.2)";
        btnToggleCamera.style.borderColor = "#ef4444";
        btnToggleCamera.style.color = "#ef4444";
        currentSourceTag.textContent = "Camera: Device Live";
        liveCameraTag.textContent = "DEVICE CAMERA LIVE";
      } catch (err) {
        btnToggleCamera.textContent = "Start Camera";
        alert("Could not access device camera: " + err.message);
      }
    }
  }

  btnToggleCamera.addEventListener("click", toggleDeviceCamera);

  // Relay Stream to Other Website (POST /api/drone/stream-frame)
  function startRelaying() {
    const rawTarget = targetWebsiteUrl.value.trim();
    if (!rawTarget) {
      alert("Please enter the destination website URL (e.g. http://localhost:3000 or your Vercel URL)");
      return;
    }

    if (!isCameraActive || deviceVideo.videoWidth === 0) {
      alert("Please click 'Start Camera' first before streaming!");
      return;
    }

    relayTarget = rawTarget.replace(/\/$/, "");
    localStorage.setItem("ecowing_target_website", relayTarget);

    isRelaying = true;
    btnStartRelay.textContent = "⏹️ Stop Streaming to Website";
    btnStartRelay.classList.remove("btn-primary");
    btnStartRelay.style.background = "#ef4444";
    liveCameraTag.textContent = "STREAMING TO: " + relayTarget;

    const ctx = deviceCanvas.getContext("2d");
    deviceCanvas.width = 640;
    deviceCanvas.height = 480;

    // Send frames at 15-20 FPS
    relayInterval = setInterval(async () => {
      if (!isRelaying || !isCameraActive || deviceVideo.videoWidth === 0) return;

      ctx.drawImage(deviceVideo, 0, 0, deviceCanvas.width, deviceCanvas.height);
      const dataUrl = deviceCanvas.toDataURL("image/jpeg", 0.7);

      try {
        // Send frame to EcoWing Website backend
        fetch(`${relayTarget}/api/drone/stream-frame`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frame: dataUrl })
        }).catch(() => {});
      } catch (e) {}
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
    liveCameraTag.textContent = isCameraActive ? "DEVICE CAMERA LIVE" : "DEVICE CAMERA STANDBY";
  }

  btnStartRelay.addEventListener("click", () => {
    if (isRelaying) {
      stopRelaying();
    } else {
      startRelaying();
    }
  });

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const uploadResult = document.getElementById("upload-result");

  if (inputBackendUrl) {
    inputBackendUrl.value = backendUrl;
  }

  // Connect Backend Logic
  function setBackend(url) {
    if (!url) return;
    url = url.trim().replace(/\/$/, "");

    // Check mixed content security
    if (window.location.protocol === "https:" && url.startsWith("http://")) {
      alert("⚠️ Mixed Content Warning:\n\nBecause this page is on HTTPS (Vercel), web browsers block unencrypted 'http://' streams.\n\nPlease either:\n1. Use a secure HTTPS tunnel (e.g. double-click 'start_tunnel.bat' to get https://...loca.lt)\n2. OR open the local dashboard directly at http://localhost:5000");
    }

    backendUrl = url;
    localStorage.setItem("ecowing_backend_url", backendUrl);
    if (inputBackendUrl) inputBackendUrl.value = backendUrl;

    bannerStatusTitle.textContent = "Connecting to " + backendUrl;
    bannerStatusSub.textContent = "Loading stream and telemetry...";

    // Reload stream image
    streamImg.src = `${backendUrl}/video_feed?overlay=${hasOverlay}&t=${Date.now()}`;
    
    loadSystemInfo();
    initWebSocket();
  }

  btnConnectBackend.addEventListener("click", () => {
    const val = inputBackendUrl.value.trim();
    if (!val) {
      alert("Please enter a valid backend stream URL (e.g. https://your-tunnel.loca.lt or http://localhost:5000)");
      return;
    }
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
      if (!res.ok) throw new Error("Backend offline");
      systemInfo = await res.json();
      
      const ip = systemInfo.local_ip || window.location.hostname;
      const port = systemInfo.port || window.location.port || "5000";
      const base = backendUrl || `http://${ip}:${port}`;
      const streamUrl = `${base}/video_feed`;
      const apiUrl = `${base}/api/detections`;
      const mobileUrl = `${base}/mobile`;

      hostIpBadge.textContent = `Backend: ${base.replace(/^https?:\/\//, '')}`;
      bannerStatusTitle.textContent = "Stream Connected: " + base;
      bannerStatusSub.textContent = "AI Waste Classification Active";
      streamStatusText.textContent = "LIVE STREAMING";

      inputStreamUrl.value = streamUrl;
      inputApiUrl.value = apiUrl;
      if (inputMobileUrl) {
        inputMobileUrl.value = mobileUrl;
      }
      if (qrCodeImg) {
        qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(mobileUrl)}`;
        qrCodeImg.classList.remove("hidden");
      }

      codeHtml.textContent = `<img \n  src="${streamUrl}" \n  alt="EcoWing Waste Stream" \n  style="width: 100%; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" \n/>`;
      codeReact.textContent = `<img \n  src="${streamUrl}" \n  alt="EcoWing Waste Stream" \n  className="w-full rounded-2xl border border-emerald-500/20 shadow-xl" \n/>`;
      codeJs.textContent = `// Poll live waste detections from EcoWing Detection Server:\nasync function checkWaste() {\n  const res = await fetch("${apiUrl}");\n  const data = await res.json();\n  console.log("Waste items:", data.data.items);\n}`;

      if (systemInfo.is_simulator) {
        currentSourceTag.textContent = "Source: Demo Simulator";
      } else {
        currentSourceTag.textContent = `Source: Camera ${systemInfo.current_source}`;
      }

      if (systemInfo.confidence_threshold) {
        const pct = Math.round(systemInfo.confidence_threshold * 100);
        confSlider.value = pct;
        confVal.textContent = `${pct}%`;
      }
    } catch (err) {
      if (isVercel && !backendUrl) {
        bannerStatusTitle.textContent = "Backend Stream Disconnected";
        bannerStatusSub.textContent = "Paste your tunnel link (https://...loca.lt) above to start stream on Vercel";
        streamStatusText.textContent = "STREAM OFFLINE";
      } else {
        bannerStatusTitle.textContent = "Backend Connection Failed";
        bannerStatusSub.textContent = "Ensure 'python run.py' or tunnel is running on your machine";
        streamStatusText.textContent = "OFFLINE";
      }
    }
  }

  // Update telemetry dashboard
  function updateTelemetry(data) {
    if (!data) return;

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

    if (data.items && data.items.length > 0) {
      let html = "";
      data.items.forEach(item => {
        const recClass = item.recyclable ? "tag-rec-yes" : "tag-rec-no";
        const recText = item.recyclable ? "Recyclable" : "Non-Recyclable";
        const bioClass = item.biodegradable ? "tag-bio-yes" : "tag-bio-no";
        const bioText = item.biodegradable ? "Bio-degradable" : "Non-Bio";

        html += `
          <div class="item-badge">
            <div class="item-main">
              <span class="item-title">${item.name} (${item.confidence}%)</span>
              <span class="item-bin">Disposal: ${item.bin}</span>
            </div>
            <div class="item-tags">
              <span class="tag ${recClass}">${recText}</span>
              <span class="tag ${bioClass}">${bioText}</span>
            </div>
          </div>
        `;
      });
      detectedItemsContainer.innerHTML = html;
    } else {
      detectedItemsContainer.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🔍</span>
          <p>No waste items in view</p>
          <small>Point camera at paper, glass, can, cardboard, or food waste</small>
        </div>
      `;
    }
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
      ws.onopen = () => {
        streamStatusText.textContent = "LIVE STREAMING";
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "telemetry") {
            updateTelemetry(payload.summary);
          }
        } catch (e) {}
      };

      ws.onerror = () => {
        startPolling();
      };

      ws.onclose = () => {
        startPolling();
      };
    } catch (e) {
      startPolling();
    }
  }

  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
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

  // Controls: Overlay toggle
  btnToggleOverlay.addEventListener("click", () => {
    hasOverlay = !hasOverlay;
    const base = backendUrl || "";
    streamImg.src = `${base}/video_feed?overlay=${hasOverlay}&t=${Date.now()}`;
    btnToggleOverlay.textContent = hasOverlay ? "Hide HUD" : "Show HUD";
  });

  // Controls: Fullscreen
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
    const confFloat = parseFloat(e.target.value) / 100.0;
    const target = backendUrl ? `${backendUrl}/api/settings` : "/api/settings";
    try {
      await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confidence: confFloat })
      });
    } catch (err) {
      console.error("Error setting confidence:", err);
    }
  });

  // Source selection dropdown
  sourceSelect.addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      customSourceRow.classList.remove("hidden");
    } else {
      customSourceRow.classList.add("hidden");
    }
  });

  btnApplySource.addEventListener("click", async () => {
    let chosenSource = sourceSelect.value;
    if (chosenSource === "custom") {
      chosenSource = customSourceInput.value.trim();
      if (!chosenSource) {
        alert("Please enter a valid video path or RTSP URL.");
        return;
      }
    }

    const target = backendUrl ? `${backendUrl}/api/settings` : "/api/settings";
    try {
      btnApplySource.textContent = "Switching...";
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: chosenSource })
      });
      const data = await res.json();
      btnApplySource.textContent = "Switch";
      
      if (data.is_simulator) {
        currentSourceTag.textContent = "Source: Demo Simulator";
      } else {
        currentSourceTag.textContent = `Source: ${data.source}`;
      }

      const base = backendUrl || "";
      streamImg.src = `${base}/video_feed?overlay=${hasOverlay}&t=${Date.now()}`;
    } catch (err) {
      btnApplySource.textContent = "Switch";
      alert("Failed to switch video source.");
    }
  });

  // Snippet Tabs
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      document.getElementById(targetId).classList.add("active");
    });
  });

  // File Upload Dropzone
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "#10b981";
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.style.borderColor = "";
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "";
    if (e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });

  async function handleFileUpload(file) {
    const formData = new FormData();
    formData.append("file", file);

    uploadResult.classList.remove("hidden");
    uploadResult.innerHTML = "<p>Analyzing waste photo with YOLO...</p>";

    const target = backendUrl ? `${backendUrl}/api/upload` : "/api/upload";
    try {
      const res = await fetch(target, {
        method: "POST",
        body: formData
      });
      const data = await res.json();

      if (data.status === "success") {
        let itemsHtml = "";
        data.analysis.items.forEach(item => {
          itemsHtml += `
            <div style="font-size: 12px; margin-top: 4px;">
              <strong>${item.name} (${item.confidence}%):</strong> 
              Recyclable: ${item.recyclable ? 'YES' : 'NO'} | 
              Bio-degradable: ${item.biodegradable ? 'YES' : 'NO'} | 
              Bin: ${item.bin}
            </div>
          `;
        });

        uploadResult.innerHTML = `
          <img src="${data.annotated_image}" alt="Processed Waste Image" />
          <h5 style="color: #10b981; font-size: 13px;">Found ${data.analysis.total_count} Waste Items</h5>
          ${itemsHtml || '<p style="font-size: 12px; color: #888;">No waste items detected in uploaded image.</p>'}
        `;
      } else {
        uploadResult.innerHTML = `<p style="color: #ef4444;">Upload error: ${data.error}</p>`;
      }
    } catch (err) {
      uploadResult.innerHTML = `<p style="color: #ef4444;">Failed to upload image.</p>`;
    }
  }

  // Copy helper
  window.copyText = function(elementId, isCode = false) {
    const el = document.getElementById(elementId);
    const text = isCode ? el.innerText : el.value;
    navigator.clipboard.writeText(text).then(() => {
      alert("Copied to clipboard!");
    }).catch(err => {
      console.error("Copy failed", err);
    });
  };

  // Error fallback on video
  streamImg.addEventListener("error", () => {
    if (isVercel && !backendUrl) {
      bannerStatusTitle.textContent = "Connect Your Stream Source";
      bannerStatusSub.textContent = "Enter your secure tunnel link (https://...loca.lt) to view video on Vercel";
    }
  });

  // Init
  if (backendUrl) {
    setBackend(backendUrl);
  } else {
    loadSystemInfo();
  }
});
