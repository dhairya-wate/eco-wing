import socket
from pathlib import Path

# Base Paths
BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "yolo26n.pt"
SAMPLE_DIR = BASE_DIR / "test_samples"

# Network Configuration
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 5000

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
        "color": (255, 230, 0),
        "bg_badge": "#00bcd4"
    },
    "can": {
        "display_name": "Metal / Beverage Can",
        "category": "Metal / Can",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow Bin (Metals)",
        "color": (0, 165, 255),
        "bg_badge": "#f39c12"
    },
    "metal": {
        "display_name": "Metal Waste",
        "category": "Metal",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow Bin (Metals)",
        "color": (0, 140, 255),
        "bg_badge": "#e67e22"
    },
    "plastic": {
        "display_name": "Plastic Waste",
        "category": "Plastic",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Yellow Bin (Plastics)",
        "color": (0, 215, 255),
        "bg_badge": "#f1c40f"
    },
    "trash": {
        "display_name": "General Waste / Trash",
        "category": "General Trash",
        "recyclable": False,
        "biodegradable": False,
        "bin": "Black/Grey Bin (Landfill)",
        "color": (128, 128, 128),
        "bg_badge": "#7f8c8d"
    },
    "organic": {
        "display_name": "Organic Waste",
        "category": "Organic",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#27ae60"
    },

    # Standard COCO dataset classes mapped to Waste Categories
    "bottle": {
        "display_name": "Bottle (Plastic/Glass)",
        "category": "Bottle (Plastic/Glass)",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Blue/Yellow Bin",
        "color": (0, 200, 255),
        "bg_badge": "#00bcd4"
    },
    "wine glass": {
        "display_name": "Glassware / Glass Bottle",
        "category": "Glass",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Cyan Bin (Glass)",
        "color": (255, 240, 0),
        "bg_badge": "#00e5ff"
    },
    "cup": {
        "display_name": "Cup / Can / Container",
        "category": "Paper/Plastic/Can",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Recyclable Bin",
        "color": (220, 180, 0),
        "bg_badge": "#e67e22"
    },
    "book": {
        "display_name": "Paper / Booklet Waste",
        "category": "Paper",
        "recyclable": True,
        "biodegradable": True,
        "bin": "Blue Bin (Paper)",
        "color": (255, 178, 50),
        "bg_badge": "#3498db"
    },
    "vase": {
        "display_name": "Ceramic / Glass Container",
        "category": "Glass / Ceramic",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Cyan Bin (Glass)",
        "color": (255, 200, 100),
        "bg_badge": "#9c27b0"
    },
    "bowl": {
        "display_name": "Plastic / Ceramic Bowl",
        "category": "Plastic / Ceramic",
        "recyclable": True,
        "biodegradable": False,
        "bin": "Recyclable Bin",
        "color": (180, 200, 50),
        "bg_badge": "#607d8b"
    },

    # Food Waste / Biodegradable COCO items
    "banana": {
        "display_name": "Banana Peel / Food Waste",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "apple": {
        "display_name": "Apple Scrap / Food Waste",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "orange": {
        "display_name": "Orange Peel / Citrus Waste",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "sandwich": {
        "display_name": "Leftover Food Waste",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "pizza": {
        "display_name": "Food Residue / Scrap",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "donut": {
        "display_name": "Food Waste Scrap",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "cake": {
        "display_name": "Food Waste Scrap",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "carrot": {
        "display_name": "Vegetable Peel / Scrap",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "broccoli": {
        "display_name": "Vegetable Scrap",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    },
    "hot dog": {
        "display_name": "Food Waste Scrap",
        "category": "Organic Food Waste",
        "recyclable": False,
        "biodegradable": True,
        "bin": "Green Bin (Compost)",
        "color": (46, 204, 113),
        "bg_badge": "#2ecc71"
    }
}

# Synonyms and alias mapping to handle different custom model class labels
ALIASES = {
    "cans": "can",
    "tin": "can",
    "aluminum": "can",
    "tin can": "can",
    "cardboard box": "cardboard",
    "carton": "cardboard",
    "paper cup": "paper",
    "newspaper": "paper",
    "magazine": "paper",
    "pet bottle": "bottle",
    "plastic bottle": "bottle",
    "glass bottle": "glass",
    "glassware": "glass",
    "food": "organic",
    "fruits": "organic",
    "vegetable": "organic"
}

def resolve_waste_item(class_name: str):
    """
    Returns waste taxonomy information if class_name is a recognized waste item.
    Returns None if class_name is NOT considered waste (e.g. person, chair, dog, etc.).
    """
    clean_name = class_name.lower().strip()
    
    # Direct match
    if clean_name in WASTE_TAXONOMY:
        return WASTE_TAXONOMY[clean_name]
    
    # Alias match
    if clean_name in ALIASES:
        target = ALIASES[clean_name]
        if target in WASTE_TAXONOMY:
            return WASTE_TAXONOMY[target]
    
    # Substring checks (e.g. "paper bag" contains "paper")
    for key, data in WASTE_TAXONOMY.items():
        if key in clean_name or clean_name in key:
            return data
            
    return None

