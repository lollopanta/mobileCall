import cv2
import numpy as np
import os

class ImageProcessingService:
    def __init__(self):
        # Load pre-trained face detector from OpenCV
        self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

    def detect_faces(self, image_path):
        """
        Detects faces in an image and returns their coordinates.
        """
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"Image not found at {image_path}")

        img = cv2.imread(image_path)
        if img is None:
            raise ValueError("Failed to load image")

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)

        # Convert faces (numpy array) to list of dicts for JSON serialization
        detected_faces = []
        for (x, y, w, h) in faces:
            detected_faces.append({
                "x": int(x),
                "y": int(y),
                "w": int(w),
                "h": int(h)
            })

        # Return detected faces and image shape
        return detected_faces, img.shape

    def crop_face(self, image_path, x, y, w, h, output_path):
        """
        Crops a specific face from the image and saves it.
        """
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError("Failed to load image for cropping")

        height, width = img.shape[:2]

        # Add some padding
        pad_x = int(w * 0.2)
        pad_y = int(h * 0.2)

        x1 = max(0, x - pad_x)
        y1 = max(0, y - pad_y)
        x2 = min(width, x + w + pad_x)
        y2 = min(height, y + h + pad_y)
        
        face_img = img[y1:y2, x1:x2]
        cv2.imwrite(output_path, face_img)
        return output_path

    def remove_background(self, frame):
        """
        Removes background from a frame using a simple thresholding and masking approach.
        In a real scenario, this would use a more advanced model like MediaPipe.
        """
        # Convert to grayscale
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Apply binary thresholding
        _, mask = cv2.threshold(gray, 120, 255, cv2.THRESH_BINARY)
        
        # Bitwise-AND mask and original image
        result = cv2.bitwise_and(frame, frame, mask=mask)
        
        # For better results, we'd use a background subtractor
        return result

    def process_frame(self, frame, role):
        """
        Processes a video frame based on the user's role.
        """
        if role == 'caregiver':
            return self.remove_background(frame)
        return frame
