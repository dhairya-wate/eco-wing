import os
import re
import socket
import math
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

# Base Paths
BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "yolo26n.pt"
SAMPLE_DIR = BASE_DIR / "test_samples"

# Security & Operator Authentication
# Documented Token Requirements:
# 1. Operator token must be at least 32 characters long.
# 2. Operator token must contain at least 12 distinct characters.
# 3. Operator token must not consist of repeated substrings or periodic patterns (e.g. "abcd" * 9 or "a" * 36).
# 4. Must be generated using a cryptographically secure random source (e.g. secrets.token_urlsafe(32)).
OPERATOR_TOKEN = os.getenv("DETECTION_OPERATOR_TOKEN", "").strip()

if not OPERATOR_TOKEN:
    raise RuntimeError(
        "CRITICAL SECURITY CONFIGURATION ERROR: DETECTION_OPERATOR_TOKEN is unset. "
        "A secure operator token of at least 32 characters must be configured in environment."
    )

if len(OPERATOR_TOKEN) < 32:
    raise RuntimeError(
        f"CRITICAL SECURITY CONFIGURATION ERROR: DETECTION_OPERATOR_TOKEN must be at least 32 characters long "
        f"(currently {len(OPERATOR_TOKEN)} characters)."
    )

# Reject repeated periodic patterns (e.g. "abcd" * 9 or "a" * 36) or insufficient character variety
is_repeated_pattern = bool(re.match(r"^(.+?)\1+$", OPERATOR_TOKEN))
if is_repeated_pattern or len(set(OPERATOR_TOKEN)) < 12:
    raise RuntimeError(
        "CRITICAL SECURITY CONFIGURATION ERROR: DETECTION_OPERATOR_TOKEN consists of a repeated pattern "
        f"or has insufficient character variety (unique chars: {len(set(OPERATOR_TOKEN))}). "
        "A cryptographically secure random token of at least 32 characters is required "
        "(e.g. python -c 'import secrets; print(secrets.token_urlsafe(32))')."
    )

# Trusted Proxies Topology:
# Exact IP addresses allowed to provide client IP via X-Forwarded-For.
# Default is an empty set/list, so proxy-forwarded IPs are unsupported until verified
# and the direct socket peer is always used.
# Consistent env lookup: checks DETECTION_TRUSTED_PROXIES first, then TRUSTED_PROXIES.
_raw_proxies = os.getenv("DETECTION_TRUSTED_PROXIES", os.getenv("TRUSTED_PROXIES", ""))
TRUSTED_PROXIES = {p.strip().lower() for p in _raw_proxies.split(",") if p.strip()}

# Network Configuration: Localhost binding by default, explicit LAN opt-in via ALLOW_LAN=true
ALLOW_LAN = os.getenv("ALLOW_LAN", "").lower() in ["true", "1", "yes"]
DEFAULT_HOST = os.getenv("HOST", "0.0.0.0" if ALLOW_LAN else "127.0.0.1")
DEFAULT_PORT = int(os.getenv("PORT", "5000"))
DEFAULT_SOURCE = os.getenv("DETECTION_SOURCE", os.getenv("VIDEO_SOURCE", "simulator"))
DETECTION_MAX_FPS = float(os.getenv("DETECTION_MAX_FPS", "30.0"))

# CORS Configuration: Explicit origin allowlist (wildcard with credentials rejected)
_raw_cors = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:8080,http://127.0.0.1:8080,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5000,http://127.0.0.1:5000"
)
CORS_ORIGINS = [orig.strip() for orig in _raw_cors.split(",") if orig.strip()]

# Limits & Features
MAX_UPLOAD_SIZE_BYTES = int(os.getenv("MAX_UPLOAD_SIZE_BYTES", str(5 * 1024 * 1024))) # 5 MB limit
MAX_WS_CONNECTIONS = int(os.getenv("MAX_WS_CONNECTIONS", "20"))
MAX_MOBILE_WS_CONNECTIONS = int(os.getenv("MAX_MOBILE_WS_CONNECTIONS", "5"))

# Mobile Stream Security & Feature Flag: Disabled by default for security
MOBILE_ENABLED = os.getenv("MOBILE_ENABLED", "false").lower() in ["true", "1", "yes"]
PAIRING_CODE_EXPIRY_SECONDS = int(os.getenv("PAIRING_CODE_EXPIRY_SECONDS", "300")) # 5 minutes
MOBILE_SESSION_EXPIRY_SECONDS = int(os.getenv("MOBILE_SESSION_EXPIRY_SECONDS", "3600")) # 1 hour

def sanitize_source_url(source_val) -> str:
    """Redacts credentials (user:pass) from RTSP/HTTP URLs for safe display and logging."""
    if not source_val:
        return ""
    src_str = str(source_val).strip()
    if "://" not in src_str:
        return src_str
    try:
        parts = urlsplit(src_str)
        if parts.username or parts.password:
            user = parts.username or ""
            netloc_clean = f"{user}:***@{parts.hostname}"
            if parts.port:
                netloc_clean += f":{parts.port}"
            return urlunsplit((parts.scheme, netloc_clean, parts.path, parts.query, parts.fragment))
    except Exception:
        pass
    return re.sub(r"://([^:@]+):([^@]+)@", r"://\1:***@", src_str)

def get_local_ip():
    """Detects the primary local LAN IP address of the host machine."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Using Google DNS or LAN probe (does not send real packets)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

# Detection Thresholds
DEFAULT_CONFIDENCE = 0.35
DEFAULT_IOU_THRESHOLD = 0.45

# Waste Taxonomy & Classification Dictionary
TAXONOMY_VERSION = "1.0.0"
CLASSIFICATION_METHOD = "coco_mapping"
ALLOWED_CLASSIFICATION_VALUES = {"yes", "no", "estimated", "depends", "unknown"}

# COCO-to-Waste Mapping Table
# Note: The model is a general-purpose COCO object detector (yolo26n).
# It does NOT directly detect materials such as paper, glass, cans, or plastic.
# Instead, supported COCO object classes are mapped to waste categories and properties.
# Each entry strictly defines:
#   coco_label, category, material ("unknown"), recyclable, biodegradable,
#   classification_method ("coco_mapping"), and model_supported (True).
COCO_WASTE_MAPPING = {
    "bottle": {
        "coco_label": "bottle",
        "category": "Container",
        "material": "unknown",
        "recyclable": "depends",
        "biodegradable": "no",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Bottle",
        "bin": "Blue / Cyan Bin (Plastics/Glass)",
        "color": (0, 140, 255),
        "bg_badge": "#06b6d4"
    },
    "cup": {
        "coco_label": "cup",
        "category": "Container",
        "material": "unknown",
        "recyclable": "depends",
        "biodegradable": "depends",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Cup",
        "bin": "Yellow / Blue Bin (Metals/Paper)",
        "color": (0, 215, 255),
        "bg_badge": "#06b6d4"
    },
    "wine glass": {
        "coco_label": "wine glass",
        "category": "Glassware",
        "material": "unknown",
        "recyclable": "yes",
        "biodegradable": "no",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Wine Glass / Glassware",
        "bin": "Cyan Bin (Glass)",
        "color": (255, 191, 0),
        "bg_badge": "#06b6d4"
    },
    "fork": {
        "coco_label": "fork",
        "category": "Cutlery",
        "material": "unknown",
        "recyclable": "depends",
        "biodegradable": "no",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Cutlery Scrap (Fork)",
        "bin": "Yellow / Blue Bin",
        "color": (192, 192, 192),
        "bg_badge": "#64748b"
    },
    "knife": {
        "coco_label": "knife",
        "category": "Cutlery",
        "material": "unknown",
        "recyclable": "depends",
        "biodegradable": "no",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Cutlery Scrap (Knife)",
        "bin": "Yellow / Blue Bin",
        "color": (192, 192, 192),
        "bg_badge": "#64748b"
    },
    "spoon": {
        "coco_label": "spoon",
        "category": "Cutlery",
        "material": "unknown",
        "recyclable": "depends",
        "biodegradable": "no",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Cutlery Scrap (Spoon)",
        "bin": "Yellow / Blue Bin",
        "color": (192, 192, 192),
        "bg_badge": "#64748b"
    },
    "bowl": {
        "coco_label": "bowl",
        "category": "Container",
        "material": "unknown",
        "recyclable": "depends",
        "biodegradable": "no",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Bowl / Dishware",
        "bin": "Mixed Waste Bin",
        "color": (200, 200, 200),
        "bg_badge": "#64748b"
    },
    "banana": {
        "coco_label": "banana",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Fruit Peel / Scrap (Banana)",
        "bin": "Green Bin (Compost)",
        "color": (0, 255, 255),
        "bg_badge": "#10b981"
    },
    "apple": {
        "coco_label": "apple",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Fruit Core / Scrap (Apple)",
        "bin": "Green Bin (Compost)",
        "color": (0, 0, 255),
        "bg_badge": "#10b981"
    },
    "sandwich": {
        "coco_label": "sandwich",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Food Scrap (Sandwich)",
        "bin": "Green Bin (Compost)",
        "color": (42, 42, 165),
        "bg_badge": "#10b981"
    },
    "orange": {
        "coco_label": "orange",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Fruit Peel (Orange)",
        "bin": "Green Bin (Compost)",
        "color": (0, 165, 255),
        "bg_badge": "#10b981"
    },
    "broccoli": {
        "coco_label": "broccoli",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Vegetable Scrap (Broccoli)",
        "bin": "Green Bin (Compost)",
        "color": (34, 139, 34),
        "bg_badge": "#10b981"
    },
    "carrot": {
        "coco_label": "carrot",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Vegetable Scrap (Carrot)",
        "bin": "Green Bin (Compost)",
        "color": (0, 140, 255),
        "bg_badge": "#10b981"
    },
    "hot dog": {
        "coco_label": "hot dog",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Food Scrap (Hot Dog)",
        "bin": "Green Bin (Compost)",
        "color": (34, 139, 34),
        "bg_badge": "#10b981"
    },
    "pizza": {
        "coco_label": "pizza",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Food Scrap (Pizza)",
        "bin": "Green Bin (Compost)",
        "color": (0, 69, 255),
        "bg_badge": "#10b981"
    },
    "donut": {
        "coco_label": "donut",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Food Scrap (Donut)",
        "bin": "Green Bin (Compost)",
        "color": (147, 20, 255),
        "bg_badge": "#10b981"
    },
    "cake": {
        "coco_label": "cake",
        "category": "Organic",
        "material": "unknown",
        "recyclable": "no",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Food Scrap (Cake)",
        "bin": "Green Bin (Compost)",
        "color": (180, 105, 255),
        "bg_badge": "#10b981"
    },
    "book": {
        "coco_label": "book",
        "category": "Paper/Reading",
        "material": "unknown",
        "recyclable": "yes",
        "biodegradable": "yes",
        "classification_method": "coco_mapping",
        "model_supported": True,
        "display_name": "Book / Reading Scrap",
        "bin": "Blue Bin (Paper/Dry)",
        "color": (235, 160, 52),
        "bg_badge": "#3b82f6"
    }
}

# Alias for backwards compatibility
WASTE_TAXONOMY = COCO_WASTE_MAPPING

def resolve_waste_item(class_name: str):
    """
    Returns waste taxonomy information if class_name is a mapped COCO waste item.
    Only mapped COCO labels produce waste items. Unmapped COCO labels return None.
    """
    if not class_name or not isinstance(class_name, str):
        return None
    clean_name = class_name.lower().strip()
    entry = COCO_WASTE_MAPPING.get(clean_name)
    if entry is not None:
        return entry.copy()
    return None
