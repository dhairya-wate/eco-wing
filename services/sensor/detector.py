import cv2
import numpy as np
import time
from ultralytics import YOLO
from config import MODEL_PATH, DEFAULT_CONFIDENCE, DEFAULT_IOU_THRESHOLD, resolve_waste_item

class WasteDetector:
    def __init__(self, model_path=None, confidence=DEFAULT_CONFIDENCE, iou=DEFAULT_IOU_THRESHOLD):
        self.model_path = str(model_path or MODEL_PATH)
        self.confidence = confidence
        self.iou = iou
        print(f"[Detector] Loading YOLO model from {self.model_path}...")
        self.model = YOLO(self.model_path)
        print(f"[Detector] Model loaded successfully with {len(self.model.names)} base classes.")
        
    def set_confidence(self, conf: float):
        self.confidence = max(0.05, min(1.0, conf))

    def detect(self, frame: np.ndarray, draw_overlay: bool = True, server_info: str = ""):
        """
        Runs object detection on the provided cv2 frame, filters strictly for waste items,
        classifies each for recyclability & biodegradability, and renders HUD badges.
        """
        h, w = frame.shape[:2]
        
        # Run YOLO inference
        results = self.model.predict(
            source=frame,
            conf=self.confidence,
            iou=self.iou,
            verbose=False
        )
        
        detected_waste = []
        annotated_frame = frame.copy() if draw_overlay else frame
        
        recyclable_count = 0
        non_recyclable_count = 0
        biodegradable_count = 0
        non_biodegradable_count = 0

        if results and len(results) > 0:
            boxes = results[0].boxes
            for box in boxes:
                cls_id = int(box.cls[0].item())
                conf = float(box.conf[0].item())
                raw_class_name = self.model.names.get(cls_id, "unknown")
                
                # Check if this class is mapped to our Waste Taxonomy
                taxonomy = resolve_waste_item(raw_class_name)
                if taxonomy is None:
                    # Ignore non-waste classes (e.g. person, car, dog, etc.)
                    continue
                
                coords = box.xyxy[0].cpu().numpy().astype(int)
                x1, y1, x2, y2 = int(coords[0]), int(coords[1]), int(coords[2]), int(coords[3])
                
                # Update statistics
                if taxonomy["recyclable"]:
                    recyclable_count += 1
                else:
                    non_recyclable_count += 1
                    
                if taxonomy["biodegradable"]:
                    biodegradable_count += 1
                else:
                    non_biodegradable_count += 1
                
                item_info = {
                    "raw_class": raw_class_name,
                    "name": taxonomy["display_name"],
                    "category": taxonomy["category"],
                    "confidence": round(conf * 100, 1),
                    "recyclable": taxonomy["recyclable"],
                    "biodegradable": taxonomy["biodegradable"],
                    "bin": taxonomy["bin"],
                    "bbox": [x1, y1, x2, y2]
                }
                detected_waste.append(item_info)
                
                if draw_overlay:
                    self._draw_waste_box(annotated_frame, x1, y1, x2, y2, item_info, taxonomy["color"])

        if draw_overlay:
            self._draw_hud(annotated_frame, len(detected_waste), recyclable_count, 
                           biodegradable_count, server_info)

        summary = {
            "total_count": len(detected_waste),
            "recyclable_count": recyclable_count,
            "non_recyclable_count": non_recyclable_count,
            "biodegradable_count": biodegradable_count,
            "non_biodegradable_count": non_biodegradable_count,
            "items": detected_waste,
            "timestamp": time.time()
        }
        
        return annotated_frame, summary

    def _draw_waste_box(self, img, x1, y1, x2, y2, item, color):
        """Draws a modern high-visibility bounding box with classification badges."""
        # Main box
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        
        # Fancy corner accents
        corner_len = min(20, (x2 - x1) // 4, (y2 - y1) // 4)
        thickness = 3
        # Top-left
        cv2.line(img, (x1, y1), (x1 + corner_len, y1), color, thickness)
        cv2.line(img, (x1, y1), (x1, y1 + corner_len), color, thickness)
        # Top-right
        cv2.line(img, (x2, y1), (x2 - corner_len, y1), color, thickness)
        cv2.line(img, (x2, y1), (x2, y1 + corner_len), color, thickness)
        # Bottom-left
        cv2.line(img, (x1, y2), (x1 + corner_len, y2), color, thickness)
        cv2.line(img, (x1, y2), (x1, y2 - corner_len), color, thickness)
        # Bottom-right
        cv2.line(img, (x2, y2), (x2 - corner_len, y2), color, thickness)
        cv2.line(img, (x2, y2), (x2 - corner_len, y2), color, thickness)

        # Header Badge: Name & Confidence
        header_text = f"{item['name']} {item['confidence']}%"
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.5
        font_thick = 1
        
        (w_txt, h_txt), _ = cv2.getTextSize(header_text, font, font_scale, font_thick)
        badge_y = max(y1 - 32, 10)
        
        # Primary label background
        cv2.rectangle(img, (x1, badge_y), (x1 + max(w_txt + 12, 180), badge_y + 18), color, -1)
        cv2.putText(img, header_text, (x1 + 6, badge_y + 13), font, font_scale, (0, 0, 0), font_thick, cv2.LINE_AA)
        
        # Sub-badges for Recyclable and Biodegradable
        rec_status = "REC: YES" if item["recyclable"] else "REC: NO"
        rec_bg = (39, 174, 96) if item["recyclable"] else (41, 128, 185) # Green vs Dark Blue
        
        bio_status = "BIO: YES" if item["biodegradable"] else "BIO: NO"
        bio_bg = (39, 174, 96) if item["biodegradable"] else (52, 73, 94) # Green vs Slate
        
        sub_y = badge_y + 20
        # Recyclable badge
        cv2.rectangle(img, (x1, sub_y), (x1 + 85, sub_y + 15), rec_bg, -1)
        cv2.putText(img, rec_status, (x1 + 4, sub_y + 11), font, 0.38, (255, 255, 255), 1, cv2.LINE_AA)
        
        # Biodegradable badge
        cv2.rectangle(img, (x1 + 90, sub_y), (x1 + 180, sub_y + 15), bio_bg, -1)
        cv2.putText(img, bio_status, (x1 + 94, sub_y + 11), font, 0.38, (255, 255, 255), 1, cv2.LINE_AA)

    def _draw_hud(self, img, total, rec, bio, server_info):
        """Draws a sleek EcoWing HUD bar on top of the live stream."""
        h, w = img.shape[:2]
        
        # Top HUD semi-transparent background bar
        overlay = img.copy()
        cv2.rectangle(overlay, (0, 0), (w, 42), (18, 22, 28), -1)
        cv2.addWeighted(overlay, 0.85, img, 0.15, 0, img)
        
        # EcoWing Branding
        font = cv2.FONT_HERSHEY_DUPLEX
        cv2.putText(img, "ECOWING AI", (14, 26), font, 0.65, (46, 204, 113), 2, cv2.LINE_AA)
        
        # Waste Counters
        font_sm = cv2.FONT_HERSHEY_SIMPLEX
        stat_text = f"WASTE: {total} | RECYCLABLE: {rec} | BIODEGRADABLE: {bio}"
        cv2.putText(img, stat_text, (170, 26), font_sm, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        
        # Stream IP Watermark on top-right
        if server_info:
            (w_info, _), _ = cv2.getTextSize(server_info, font_sm, 0.42, 1)
            cv2.putText(img, server_info, (w - w_info - 14, 26), font_sm, 0.42, (180, 200, 220), 1, cv2.LINE_AA)

