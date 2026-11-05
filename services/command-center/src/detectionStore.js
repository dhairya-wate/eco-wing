const fs = require('fs');
const path = require('path');
const { inferMaterialType, inferDualAxisClassification } = require('./models/Detection');

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
    if (data.canonical_event_id) {
      const existing = this.events.find(e => e.canonical_event_id === data.canonical_event_id);
      if (existing) {
        return existing;
      }
    }

    const rawConf = Number(data.confidence) || 0;
    // Normalize confidence to 0.0 - 1.0 range
    const confidence = rawConf > 1 ? Number((rawConf / 100).toFixed(2)) : Number(rawConf.toFixed(2));
    
    const className = String(data.class_name || 'Waste Item').trim();
    const eco = inferDualAxisClassification(className, data);
    const materialType = (['Recyclable', 'Biodegradable', 'Non-Recyclable'].includes(data.material_type))
      ? data.material_type
      : eco.material_type;

    const eventId = Number(data.event_id) || this.nextEventId++;
    if (eventId >= this.nextEventId) {
      this.nextEventId = eventId + 1;
    }

    const center = Array.isArray(data.center) && data.center.length === 2
      ? [Number(data.center[0]), Number(data.center[1])]
      : [320, 240];

    const timestamp = data.timestamp || new Date().toISOString().replace('T', ' ').substring(0, 19);

    const isRecyclable = data.is_recyclable !== undefined
      ? Boolean(data.is_recyclable)
      : (data.recyclable !== undefined ? ['yes', 'true', 'estimated'].includes(String(data.recyclable).toLowerCase()) || data.recyclable === true : eco.is_recyclable);

    const isBiodegradable = data.is_biodegradable !== undefined
      ? Boolean(data.is_biodegradable)
      : (data.biodegradable !== undefined ? ['yes', 'true', 'estimated'].includes(String(data.biodegradable).toLowerCase()) || data.biodegradable === true : eco.is_biodegradable);

    const detObj = {
      event_id: eventId,
      canonical_event_id: data.canonical_event_id || null,
      drone_id: data.drone_id || 'Drone-01',
      class_name: className,
      coco_label: data.coco_label || className,
      material_type: materialType,
      category: data.category || 'General',
      material: data.material || 'unknown',
      is_recyclable: isRecyclable,
      is_biodegradable: isBiodegradable,
      recyclable: isRecyclable ? 'yes' : 'no',
      biodegradable: isBiodegradable ? 'yes' : 'no',
      disposal_bin: data.disposal_bin || eco.disposal_bin,
      confidence: confidence,
      center: center,
      bbox: data.bbox || null,
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

  getByCanonicalEventId(canonicalId) {
    if (!canonicalId) return [];
    return this.events.filter(e => e.canonical_event_id === canonicalId);
  }

  clear() {
    this.events = [];
    this.nextEventId = 1;
    this.saveToDisk();
  }

  getEvents(limit = 200) {
    return this.events.slice(0, limit);
  }

  getStats() {
    const classCounts = {};
    const materialCounts = { recyclable: 0, biodegradable: 0, non_recyclable: 0 };
    let recyclableCount = 0;
    let nonRecyclableCount = 0;
    let biodegradableCount = 0;
    let nonBiodegradableCount = 0;

    this.events.forEach(item => {
      classCounts[item.class_name] = (classCounts[item.class_name] || 0) + 1;
      const k = String(item.material_type || '').toLowerCase();
      if (k.includes('recyclable') && !k.includes('non')) materialCounts.recyclable++;
      else if (k.includes('bio')) materialCounts.biodegradable++;
      else materialCounts.non_recyclable++;

      if (item.is_recyclable || item.recyclable === 'yes' || item.recyclable === true) recyclableCount++;
      else nonRecyclableCount++;

      if (item.is_biodegradable || item.biodegradable === 'yes' || item.biodegradable === true) biodegradableCount++;
      else nonBiodegradableCount++;
    });

    return {
      total_unique: this.events.length,
      class_counts: classCounts,
      material_counts: materialCounts,
      recyclable_count: recyclableCount,
      non_recyclable_count: nonRecyclableCount,
      biodegradable_count: biodegradableCount,
      non_biodegradable_count: nonBiodegradableCount
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
