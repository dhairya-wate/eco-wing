/**
 * Canonical Detection Event Schema Validator
 * Validates payloads against contracts/detection-event.schema.json
 */

const CANONICAL_CLASS_IDS = new Set([
  'bottle', 'cup', 'wine_glass', 'fork', 'knife', 'spoon',
  'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli',
  'carrot', 'hot_dog', 'pizza', 'donut', 'cake', 'book'
]);

const ALLOWED_SOURCES = new Set(['camera', 'mobile', 'upload']);
const ALLOWED_MATERIALS = new Set(['unknown', 'plastic', 'glass', 'metal', 'paper', 'cardboard', 'organic']);
const ALLOWED_ENUM_VALUES = new Set(['yes', 'no', 'estimated', 'depends', 'unknown']);

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DRONE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * Validates a canonical detection event object according to detection-event.schema.json.
 * @param {object} event
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateCanonicalDetectionEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { valid: false, errors: ['Detection event payload must be an object.'] };
  }

  // Required top-level keys
  const requiredFields = [
    'event_id', 'drone_id', 'source', 'observed_at',
    'taxonomy_version', 'classification_method', 'items'
  ];
  for (const f of requiredFields) {
    if (event[f] === undefined || event[f] === null) {
      errors.push(`Missing required field: '${f}'.`);
    }
  }

  // Top-level properties validation
  if (event.event_id && !UUID_REGEX.test(String(event.event_id))) {
    errors.push(`'event_id' must be a valid UUIDv4 string (got '${event.event_id}').`);
  }

  if (event.drone_id && !DRONE_ID_REGEX.test(String(event.drone_id))) {
    errors.push(`'drone_id' must be alphanumeric string between 1-64 chars (got '${event.drone_id}').`);
  }

  if (event.source && !ALLOWED_SOURCES.has(String(event.source))) {
    errors.push(`'source' must be one of: camera, mobile, upload (got '${event.source}').`);
  }

  if (event.observed_at) {
    const parsed = Date.parse(event.observed_at);
    if (isNaN(parsed)) {
      errors.push(`'observed_at' must be a valid ISO 8601 UTC date-time string.`);
    }
  }

  if (event.taxonomy_version && !SEMVER_REGEX.test(String(event.taxonomy_version))) {
    errors.push(`'taxonomy_version' must follow semver X.Y.Z (got '${event.taxonomy_version}').`);
  }

  if (event.classification_method && event.classification_method !== 'coco_mapping') {
    errors.push(`'classification_method' must be 'coco_mapping' (got '${event.classification_method}').`);
  }

  // Validate items array
  if (event.items !== undefined) {
    if (!Array.isArray(event.items)) {
      errors.push(`'items' must be an array.`);
    } else {
      for (let i = 0; i < event.items.length; i++) {
        const item = event.items[i];
        if (!item || typeof item !== 'object') {
          errors.push(`item[${i}] must be an object.`);
          continue;
        }

        // Required item fields: class_id, coco_label, confidence, bbox
        if (!item.class_id || !CANONICAL_CLASS_IDS.has(String(item.class_id))) {
          errors.push(`item[${i}].class_id must be a canonical taxonomy identifier (got '${item.class_id}').`);
        }

        if (typeof item.coco_label !== 'string' || !item.coco_label.trim()) {
          errors.push(`item[${i}].coco_label must be a non-empty string.`);
        }

        if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0.0 || item.confidence > 1.0) {
          errors.push(`item[${i}].confidence must be a finite number between 0.0 and 1.0 (got '${item.confidence}').`);
        }

        // Bounding box validation (array of 4 numbers or object with x_min, y_min, x_max, y_max)
        if (Array.isArray(item.bbox)) {
          if (item.bbox.length !== 4 || !item.bbox.every(n => typeof n === 'number' && Number.isFinite(n))) {
            errors.push(`item[${i}].bbox array must contain exactly 4 numeric coordinates [x_min, y_min, x_max, y_max].`);
          }
        } else if (item.bbox && typeof item.bbox === 'object') {
          const { x_min, y_min, x_max, y_max } = item.bbox;
          if (
            typeof x_min !== 'number' || !Number.isFinite(x_min) ||
            typeof y_min !== 'number' || !Number.isFinite(y_min) ||
            typeof x_max !== 'number' || !Number.isFinite(x_max) ||
            typeof y_max !== 'number' || !Number.isFinite(y_max)
          ) {
            errors.push(`item[${i}].bbox object must have finite numeric x_min, y_min, x_max, y_max.`);
          }
        } else {
          errors.push(`item[${i}].bbox is required and must be an array or coordinate object.`);
        }

        // Optional item enums
        if (item.material !== undefined && !ALLOWED_MATERIALS.has(String(item.material))) {
          errors.push(`item[${i}].material '${item.material}' is not a valid enum value.`);
        }
        if (item.recyclable !== undefined && !ALLOWED_ENUM_VALUES.has(String(item.recyclable))) {
          errors.push(`item[${i}].recyclable '${item.recyclable}' is not a valid enum value.`);
        }
        if (item.biodegradable !== undefined && !ALLOWED_ENUM_VALUES.has(String(item.biodegradable))) {
          errors.push(`item[${i}].biodegradable '${item.biodegradable}' is not a valid enum value.`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates any incoming detection payload (canonical or legacy).
 * @param {object} body
 * @returns {{ valid: boolean, isCanonical: boolean, error?: string }}
 */
function validateDetectionPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, isCanonical: false, error: 'Request body must be a JSON object.' };
  }

  // Canonical format if items or event_id or classification_method present
  if (body.items !== undefined || body.classification_method !== undefined || (body.event_id && typeof body.event_id === 'string' && body.event_id.includes('-'))) {
    const res = validateCanonicalDetectionEvent(body);
    if (!res.valid) {
      return { valid: false, isCanonical: true, error: res.errors.join(' ') };
    }
    return { valid: true, isCanonical: true };
  }

  // Legacy single detection format
  const rawClass = body.class_name || (body.waste_type ? String(body.waste_type).toLowerCase() : null);
  if (!rawClass) {
    return { valid: false, isCanonical: false, error: "Missing required detection field: 'class_name' or 'items'." };
  }

  if (body.drone_id !== undefined && !DRONE_ID_REGEX.test(String(body.drone_id))) {
    return { valid: false, isCanonical: false, error: `Invalid drone_id: '${body.drone_id}'.` };
  }

  if (body.confidence !== undefined) {
    if (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence) || body.confidence < 0.0 || body.confidence > 1.0) {
      return { valid: false, isCanonical: false, error: `Confidence must be a finite number between 0.0 and 1.0 (got '${body.confidence}').` };
    }
  }

  return { valid: true, isCanonical: false };
}

module.exports = {
  CANONICAL_CLASS_IDS,
  ALLOWED_SOURCES,
  validateCanonicalDetectionEvent,
  validateDetectionPayload
};
