# 🌱 EcoWing Waste Detection & Streaming System

A real-time AI computer vision software designed for the **EcoWing Project**. It detects waste items, classifies them into **Recyclable / Non-Recyclable** and **Biodegradable / Non-Biodegradable**, and streams live video directly to the EcoWing website over a local network or IP address.

---

## 🚀 Key Features

1. **Pretrained YOLO AI Detection:**
   - Detects waste items including **Paper**, **Glass**, **Can / Metal**, **Cardboard**, **Plastic**, and **Organic Food Waste**.
   - Strictly ignores non-waste items (humans, animals, furniture, backgrounds).

2. **Dual-Axis Eco Classification:**
   - **Recyclable:** `YES` or `NO`
   - **Biodegradable:** `YES` or `NO`
   - **Disposal Recommendation:** Identifies the correct bin (Blue, Green, Yellow, Cyan, Landfill).

3. **High-Performance Website Live Streaming:**
   - Streams live annotated video over MJPEG (`/video_feed`).
   - Any website can embed it with a simple `<img>` tag without plugins or complex players.
   - Fully enabled with **CORS** for seamless cross-origin communication.

4. **Real-Time Telemetry & REST API:**
   - `/api/detections`: Live JSON feed of detected items, confidence scores, bounding boxes, and eco-counts.
   - `/ws`: High-speed WebSocket connection for live telemetry push.

5. **Built-in Web Control Hub (`http://<IP>:5000`):**
   - Live preview monitor with toggleable HUD overlay.
   - Dynamic confidence threshold slider.
   - Source switcher (Webcam 0, Webcam 1, Demo Simulator, RTSP stream, or video file).
   - Drag-and-drop test image analyzer.

---

## 📡 Live Stream & Website Connection Links

When the server is running on your machine:

| Feature | Endpoint URL | Description |
| :--- | :--- | :--- |
| **Web Dashboard** | `http://localhost:5000` or `http://192.168.31.44:5000` | Full browser control interface |
| **Video Stream URL** | `http://192.168.31.44:5000/video_feed` | Direct MJPEG video feed for website embed |
| **Telemetry API** | `http://192.168.31.44:5000/api/detections` | Live waste counts & classification JSON |
| **WebSocket** | `ws://192.168.31.44:5000/ws` | Low-latency live stream data feed |
| **System Info** | `http://192.168.31.44:5000/api/system_info` | Network status and copyable embed codes |

*(Note: Replace `192.168.31.44` with your machine's current local IP address if it changes).*

---

## 💻 How to Connect to the EcoWing Website

### 1. In Plain HTML
Simply paste this image tag into your website's HTML template:
```html
<div class="stream-container">
  <h3>EcoWing AI Live Detection Feed</h3>
  <img 
    src="http://192.168.31.44:5000/video_feed" 
    alt="EcoWing Waste Detection Stream" 
    style="width: 100%; max-width: 800px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);"
  />
</div>
```

### 2. In React / Next.js
```jsx
export default function WasteStreamWidget() {
  const streamUrl = "http://192.168.31.44:5000/video_feed";

  return (
    <div className="p-4 bg-gray-900 rounded-2xl shadow-xl">
      <h2 className="text-emerald-400 font-bold mb-3">EcoWing Live Sorting Stream</h2>
      <img 
        src={streamUrl} 
        alt="EcoWing Stream" 
        className="w-full rounded-xl border border-emerald-500/20 shadow-md"
      />
    </div>
  );
}
```

### 3. Fetching Real-Time Waste Counters in JavaScript
```javascript
// Poll current waste counts and items every 1 second
async function fetchEcoWingStats() {
  try {
    const res = await fetch("http://192.168.31.44:5000/api/detections");
    const json = await res.json();
    const data = json.data;

    console.log(`Total Waste: ${data.total_count}`);
    console.log(`Recyclable: ${data.recyclable_count}`);
    console.log(`Biodegradable: ${data.biodegradable_count}`);
    
    // List of individual items in view
    data.items.forEach(item => {
      console.log(`${item.name} (${item.confidence}%): Recyclable=${item.recyclable}, Bio=${item.biodegradable}`);
    });
  } catch (err) {
    console.error("EcoWing Server Offline:", err);
  }
}

setInterval(fetchEcoWingStats, 1000);
```

---

## 🗂️ Waste Classification Rules

| Item | Category | Recyclable? | Biodegradable? | Bin Recommendation |
| :--- | :--- | :---: | :---: | :--- |
| **Paper / Booklet** | Paper | ✅ YES | ✅ YES | Blue Bin (Paper/Dry) |
| **Cardboard Box** | Cardboard | ✅ YES | ✅ YES | Blue Bin (Paper/Dry) |
| **Glass Bottle / Scrap** | Glass | ✅ YES | ❌ NO | Cyan / Glass Bin |
| **Beverage Can / Tin** | Metal / Can | ✅ YES | ❌ NO | Yellow Bin (Metals) |
| **Plastic Bottle** | Plastic | ✅ YES | ❌ NO | Yellow / Recyclable Bin |
| **Food Scrap / Peels** | Organic | ❌ NO | ✅ YES | Green Bin (Compost) |

---

## 🏃 How to Run the Detection Server

In your terminal inside `detction system`:

```bash
python run.py
```
Or with custom port:
```bash
python -m uvicorn app:app --host 0.0.0.0 --port 5000
```

Open `http://localhost:5000` or `http://192.168.31.44:5000` in any web browser to view the control center.

