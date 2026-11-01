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
# Defines categories, recyclability, biodegradability, and recommended disposal bins.
WASTE_TAXONOMY = {
    # Direct waste classes (from custom waste models like TrashNet / TACO / Roboflow)
    "paper": {
        "display_name": "Paper Waste",
        "category": "Paper",
        "recyclable": True,
        "biodegradable": True,
        "bin": "Blue Bin (Paper/Dry)",
        "color": (235, 160, 52),     # BGR
        "bg_badge": "#3498db"
    },
    "cardboard": {
        "display_name": "Cardboard Box / Scrap",
        "category": "Cardboard",
        "recyclable": True,
        "biodegradable": True,
        "bin": "Blue Bin (Paper/Dry)",
        "color": (139, 105, 20),
        "bg_badge": "#8e44ad"
    },
    "glass": {
        "display_name": "Glass Scrap / Bottle",
        "category": "Glass",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Cyan Bin (Glass)",
        "color": (255, 191, 0),
        "bg_badge": "#00bcd4"
    },
    "metal": {
        "display_name": "Metal / Tin Scrap",
        "category": "Metal",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow Bin (Metals)",
        "color": (0, 215, 255),
        "bg_badge": "#f1c40f"
    },
    "can": {
        "display_name": "Beverage Can / Aluminum",
        "category": "Metal",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow Bin (Metals)",
        "color": (0, 215, 255),
        "bg_badge": "#f1c40f"
    },
    "plastic": {
        "display_name": "Plastic Scrap / Container",
        "category": "Plastic",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Blue Bin (Plastics)",
        "color": (0, 140, 255),
        "bg_badge": "#e67e22"
    },
    "trash": {
        "display_name": "General Waste / Trash",
        "category": "General",
        "recyclable": False,
        "biodegradable": False,
        "bin": "Black Bin (Landfill)",
        "color": (128, 128, 128),
        "bg_badge": "#7f8c8d"
    },
    "compost": {
        "display_name": "Organic / Compostable Scrap",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (50, 205, 50),
        "bg_badge": "#2ecc71"
    },

    # Standard COCO object mappings -> Approximate Waste Counterparts
    "bottle": {
        "display_name": "Plastic / Glass Bottle",
        "category": "Plastic / Glass",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Blue Bin (Plastics/Glass)",
        "color": (0, 140, 255),
        "bg_badge": "#06b6d4"
    },
    "wine glass": {
        "display_name": "Glassware / Glass Scrap",
        "category": "Glass",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Cyan Bin (Glass)",
        "color": (255, 191, 0),
        "bg_badge": "#00e5ff"
    },
    "cup": {
        "display_name": "Beverage Cup / Can",
        "category": "Metal / Paper",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow Bin (Metals/Paper)",
        "color": (0, 215, 255),
        "bg_badge": "#f59e0b"
    },
    "fork": {
        "display_name": "Disposable Cutlery (Fork)",
        "category": "Plastic / Metal",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow / Blue Bin",
        "color": (200, 200, 200),
        "bg_badge": "#64748b"
    },
    "knife": {
        "display_name": "Disposable Cutlery (Knife)",
        "category": "Plastic / Metal",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow / Blue Bin",
        "color": (200, 200, 200),
        "bg_badge": "#64748b"
    },
    "spoon": {
        "display_name": "Disposable Cutlery (Spoon)",
        "category": "Plastic / Metal",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow / Blue Bin",
        "color": (200, 200, 200),
        "bg_badge": "#64748b"
    },
    "bowl": {
        "display_name": "Bowl / Food Container",
        "category": "Plastic / Ceramic",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Recyclable Waste",
        "color": (160, 160, 160),
        "bg_badge": "#64748b"
    },
    "banana": {
        "display_name": "Banana Peel / Fruit Scrap",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (0, 255, 255),
        "bg_badge": "#10b981"
    },
    "apple": {
        "display_name": "Apple Core / Fruit Scrap",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (0, 0, 255),
        "bg_badge": "#10b981"
    },
    "sandwich": {
        "display_name": "Food Scrap / Bread",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (34, 139, 34),
        "bg_badge": "#10b981"
    },
    "orange": {
        "display_name": "Orange Peel / Citrus",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (0, 165, 255),
        "bg_badge": "#10b981"
    },
    "broccoli": {
        "display_name": "Vegetable Scrap (Broccoli)",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (34, 139, 34),
        "bg_badge": "#10b981"
    },
    "carrot": {
        "display_name": "Vegetable Scrap (Carrot)",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (0, 140, 255),
        "bg_badge": "#10b981"
    },
    "pizza": {
        "display_name": "Pizza Crust / Food Waste",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (0, 69, 255),
        "bg_badge": "#10b981"
    },
    "donut": {
        "display_name": "Pastry / Food Scrap",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (147, 20, 255),
        "bg_badge": "#10b981"
    },
    "cake": {
        "display_name": "Bakery Food Scrap",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (180, 105, 255),
        "bg_badge": "#10b981"
    },
    "book": {
        "display_name": "Paper / Book Scrap",
        "category": "Paper",
        "recyclable": True,
        "biodegradable": True,
        "bin": "Blue Bin (Paper/Dry)",
        "color": (235, 160, 52),
        "bg_badge": "#3b82f6"
    }
}

ALIASES = {
    "cans": "can",
    "tin": "can",
    "aluminum": "can",
    "tin can": "can",
    "cardboard box": "cardboard",
    "carton": "cardboard",
    "paper cup": "cup",
    "newspaper": "paper",
    "magazine": "paper",
    "pet bottle": "bottle",
    "plastic bottle": "bottle",
    "glass bottle": "glass",
    "glassware": "glass"
}

def resolve_waste_item(class_name: str):
    """
    Returns waste taxonomy information if class_name is a recognized waste item.
    Returns None if class_name is NOT considered waste (e.g. person, chair, dog, etc.).
    """
    clean_name = class_name.lower().strip()
    if clean_name in WASTE_TAXONOMY:
        return WASTE_TAXONOMY[clean_name]
    if clean_name in ALIASES:
        target = ALIASES[clean_name]
        if target in WASTE_TAXONOMY:
            return WASTE_TAXONOMY[target]
    for key, data in WASTE_TAXONOMY.items():
        if key in clean_name or clean_name in key:
            return data
    return None

