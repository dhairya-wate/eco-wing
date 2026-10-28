document.addEventListener("DOMContentLoaded", () => {
  let hasOverlay = true;
  let systemInfo = null;

  // DOM Elements
  const hostIpBadge = document.getElementById("host-ip-badge");
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

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const uploadResult = document.getElementById("upload-result");

  // Load System Info
  async function loadSystemInfo() {
    try {
      const res = await fetch("/api/system_info");
      systemInfo = await res.json();
      
      const ip = systemInfo.local_ip || window.location.hostname;
      const port = systemInfo.port || window.location.port || "5000";
      const streamUrl = `http://${ip}:${port}/video_feed`;
      const apiUrl = `http://${ip}:${port}/api/detections`;
      const mobileUrl = `http://${ip}:${port}/mobile`;

      hostIpBadge.textContent = `IP: ${ip}:${port}`;
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
      console.error("Failed to load system info:", err);
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

    // Render detected items list
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "telemetry") {
          updateTelemetry(payload.summary);
        }
      } catch (e) {
        console.error("WS Parse error:", e);
      }
    };

    ws.onerror = () => {
      // Fallback to HTTP polling
      startPolling();
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 3000);
    };
  }

  function startPolling() {
    setInterval(async () => {
      try {
        const res = await fetch("/api/detections");
        const json = await res.json();
        if (json.status === "success") {
          updateTelemetry(json.data);
        }
      } catch (e) {}
    }, 1000);
  }

  // Controls: Overlay toggle
  btnToggleOverlay.addEventListener("click", () => {
    hasOverlay = !hasOverlay;
    streamImg.src = `/video_feed?overlay=${hasOverlay}&t=${Date.now()}`;
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
    try {
      await fetch("/api/settings", {
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

    try {
      btnApplySource.textContent = "Switching...";
      const res = await fetch("/api/settings", {
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

      // Refresh stream image
      streamImg.src = `/video_feed?overlay=${hasOverlay}&t=${Date.now()}`;
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

    try {
      const res = await fetch("/api/upload", {
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

  // Init
  loadSystemInfo();
  initWebSocket();
});

