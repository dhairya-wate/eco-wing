import cv2
import numpy as np
from pathlib import Path
from config import SAMPLE_DIR

def create_sample_images():
    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    
    # 1. Plastic / Glass Bottle
    img_bottle = np.full((480, 640, 3), (240, 240, 240), dtype=np.uint8)
    # Draw bottle shape
    cv2.rectangle(img_bottle, (270, 180), (370, 420), (220, 120, 50), -1) # Bottle body
    cv2.rectangle(img_bottle, (295, 120), (345, 180), (220, 120, 50), -1) # Neck
    cv2.rectangle(img_bottle, (290, 100), (350, 120), (0, 0, 200), -1)   # Cap
    cv2.putText(img_bottle, "PLASTIC BOTTLE", (220, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (40, 40, 40), 2)
    cv2.imwrite(str(SAMPLE_DIR / "sample_bottle.jpg"), img_bottle)

    # 2. Cup / Can
    img_cup = np.full((480, 640, 3), (245, 245, 245), dtype=np.uint8)
    pts = np.array([[260, 180], [380, 180], [350, 400], [290, 400]], np.int32)
    cv2.fillPoly(img_cup, [pts], (80, 180, 240))
    cv2.ellipse(img_cup, (320, 180), (60, 20), 0, 0, 360, (50, 140, 200), -1)
    cv2.putText(img_cup, "DISPOSABLE CUP / CAN", (180, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (30, 30, 30), 2)
    cv2.imwrite(str(SAMPLE_DIR / "sample_cup.jpg"), img_cup)

    # 3. Book / Paper Waste
    img_paper = np.full((480, 640, 3), (235, 235, 235), dtype=np.uint8)
    cv2.rectangle(img_paper, (200, 150), (440, 380), (255, 255, 255), -1)
    cv2.rectangle(img_paper, (200, 150), (440, 380), (180, 180, 180), 2)
    for y in range(180, 360, 20):
        cv2.line(img_paper, (220, y), (420, y), (200, 200, 200), 1)
    cv2.putText(img_paper, "ECO PAPER / BOOKLET", (180, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (30, 30, 30), 2)
    cv2.imwrite(str(SAMPLE_DIR / "sample_paper.jpg"), img_paper)

    # 4. Organic Fruit Peel / Banana
    img_fruit = np.full((480, 640, 3), (240, 240, 240), dtype=np.uint8)
    cv2.ellipse(img_fruit, (320, 260), (130, 50), 30, 0, 360, (0, 215, 255), -1)
    cv2.putText(img_fruit, "ORGANIC BANANA PEEL", (180, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (30, 30, 30), 2)
    cv2.imwrite(str(SAMPLE_DIR / "sample_organic.jpg"), img_fruit)

    print(f"[Samples] Generated 4 test images in {SAMPLE_DIR}")

if __name__ == "__main__":
    create_sample_images()

