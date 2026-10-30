const fs = require('fs');
const path = require('path');
const { inferMaterialType } = require('./models/Detection');

// Choose persistent storage path: /tmp on serverless/Vercel or ./data locally
const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const storageDir = isVercel ? '/tmp' : path.join(__dirname, 'data');
const storageFile = path.join(storageDir, 'ecowing_detections.json');

const CLASS_COLORS = [
  '#4453e0', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6',
  '#06b6d4', '#10b981', '#f97316', '#6366f1', '#14b8a6'
];

class DetectionStore {
  constructor() {
    this.events = [];
    this.nextEventId = 1;
    this.ensureDir();
    this.loadFromDisk();
  }

  ensureDir() {
    try {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[DetectionStore] Warning creating dir:', e.message);
    }
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(storageFile)) {
        const raw = fs.readFileSync(storageFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.events = parsed;
          const maxId = parsed.reduce((max, d) => Math.max(max, Number(d.event_id) || 0), 0);
          this.nextEventId = maxId + 1;
          console.log(`[DetectionStore] Loaded ${this.events.length} saved detections from persistent store.`);
        }
      }
    } catch (err) {
      console.warn('[DetectionStore] Could not read disk store:', err.message);
    }
  }

  saveToDisk() {
    try {
      this.ensureDir();
      fs.writeFileSync(storageFile, JSON.stringify(this.events.slice(-500), null, 2), 'utf8');
    } catch (err) {
      console.warn('[DetectionStore] Could not write disk store:', err.message);
    }
  }

  addDetection(data) {
    const rawConf = Number(data.confidence) || 0;
    // Normalize confidence to 0.0 - 1.0 range
    const confidence = rawConf > 1 ? Number((rawConf / 100).toFixed(2)) : Number(rawConf.toFixed(2));
    
    const className = String(data.class_name || 'Waste Item').trim();
    const materialType = (['Recyclable', 'Biodegradable', 'Non-Recyclable'].includes(data.material_type))
      ? data.material_type
      : inferMaterialType(className);

    const eventId = Number(data.event_id) || this.nextEventId++;
    if (eventId >= this.nextEventId) {
      this.nextEventId = eventId + 1;
    }

    const center = Array.isArray(data.center) && data.center.length === 2
      ? [Number(data.center[0]), Number(data.center[1])]
      : [320, 240];

    const timestamp = data.timestamp || new Date().toISOString().replace('T', ' ').substring(0, 19);

    const detObj = {
      event_id: eventId,
      drone_id: data.drone_id || 'Drone-01',
      class_name: className,
      material_type: materialType,
      confidence: confidence,
      center: center,
      timestamp: timestamp,
      createdAt: data.createdAt || new Date().toISOString()
    };

    // Keep up to 500 in memory
    this.events.unshift(detObj);
    if (this.events.length > 500) {
      this.events = this.events.slice(0, 500);
    }

    this.saveToDisk();
    return detObj;
  }

  getEvents(limit = 200) {
    return this.events.slice(0, limit);
  }

  getStats() {
    const classCounts = {};
    const materialCounts = { recyclable: 0, biodegradable: 0, non_recyclable: 0 };

    this.events.forEach(item => {
      classCounts[item.class_name] = (classCounts[item.class_name] || 0) + 1;
      const k = String(item.material_type || '').toLowerCase();
      if (k.includes('recyclable') && !k.includes('non')) materialCounts.recyclable++;
      else if (k.includes('bio')) materialCounts.biodegradable++;
      else materialCounts.non_recyclable++;
    });

    return {
      total_unique: this.events.length,
      class_counts: classCounts,
      material_counts: materialCounts
    };
  }

  getChartData() {
    const stats = this.getStats();
    const labels = Object.keys(stats.class_counts);
    const data = Object.values(stats.class_counts);
    const colors = labels.map((_, i) => CLASS_COLORS[i % CLASS_COLORS.length]);

    return {
      labels,
      data,
      colors,
      eco: {
        labels: ['Recyclable', 'Biodegradable', 'Non-Recyclable'],
        data: [
          stats.material_counts.recyclable,
          stats.material_counts.biodegradable,
          stats.material_counts.non_recyclable
        ],
        colors: ['#10b981', '#84cc16', '#f59e0b']
      }
    };
  }

  clear() {
    this.events = [];
    this.nextEventId = 1;
    this.saveToDisk();
  }
}

// Singleton instance
const store = new DetectionStore();
module.exports = store;
