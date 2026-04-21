import smbus2
import math
import time
import asyncio
import os
import sys

# Add parent directory to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from setupDB import log_fall_event, get_connection

# MPU6050 Registers
PWR_MGMT_1 = 0x6B
ACCEL_XOUT_H = 0x3B
ACCEL_YOUT_H = 0x3D
ACCEL_ZOUT_H = 0x3F

class FallSensorService:
    def __init__(self, bus_number=1, device_address=0x68, retries=5):
        self.bus_number = bus_number
        self.address = device_address
        self.enabled = False
        self.bus = None
        
        for i in range(retries):
            try:
                self.bus = smbus2.SMBus(self.bus_number)
                # Wake up MPU6050
                self.bus.write_byte_data(self.address, PWR_MGMT_1, 0)
                # Verify connection by reading WHO_AM_I
                who_am_i = self.bus.read_byte_data(self.address, 0x75)
                print(f"MPU6050 initialized successfully at {hex(self.address)}. WHO_AM_I: {hex(who_am_i)}")
                self.enabled = True
                break
            except Exception as e:
                print(f"Attempt {i+1}/{retries}: Could not initialize MPU6050: {e}")
                if self.bus:
                    self.bus.close()
                time.sleep(1)

        self.threshold_impact = 2.5 # G-force threshold for impact
        self.threshold_freefall = 0.3 # G-force threshold for freefall
        
    def read_raw_data(self, addr):
        if not self.bus:
            raise Exception("I2C bus not initialized")
        try:
            high = self.bus.read_byte_data(self.address, addr)
            low = self.bus.read_byte_data(self.address, addr + 1)
            # Combine high and low for 16-bit value
            value = (high << 8) | low
            # Get signed value
            if value > 32768:
                value = value - 65536
            return value
        except OSError as e:
            # Re-raise to be handled by the loop
            self.enabled = False
            raise e

    def get_accel_g(self):
        # Sensitivity for +/- 2g range is 16384 LSB/g
        x = self.read_raw_data(ACCEL_XOUT_H) / 16384.0
        y = self.read_raw_data(ACCEL_YOUT_H) / 16384.0
        z = self.read_raw_data(ACCEL_ZOUT_H) / 16384.0
        return x, y, z

    async def start_monitoring(self, sio_server, grandparent_username):
        print(f"Starting fall monitoring for user: {grandparent_username}")
        
        # Get user and family info
        def _get_user_info():
            conn = get_connection()
            cursor = conn.cursor()
            cursor.execute('SELECT id, family_id FROM users WHERE username = ?', (grandparent_username,))
            res = cursor.fetchone()
            conn.close()
            return res
        
        user_info = _get_user_info()
        if not user_info:
            print(f"Error: Grandparent user '{grandparent_username}' not found in database.")
            return
        
        grandparent_id, family_id = user_info
        if not family_id:
            print(f"Error: User '{grandparent_username}' is not in a family.")
            return

        while True:
            if not self.enabled:
                print("Sensor not enabled, attempting to re-initialize...")
                self.__init__(self.bus_number, self.address)
                if not self.enabled:
                    await asyncio.sleep(10)
                    continue

            try:
                # Use run_in_executor for blocking I2C reads
                loop = asyncio.get_event_loop()
                x, y, z = await loop.run_in_executor(None, self.get_accel_g)
                
                total_accel = math.sqrt(x**2 + y**2 + z**2)
                
                if total_accel > self.threshold_impact:
                    print(f"!!! FALL DETECTED !!! Total Acceleration: {total_accel:.2f}g")
                    
                    # Log the event
                    await loop.run_in_executor(None, log_fall_event, grandparent_id, family_id)
                    
                    # Emit emergency event to the family room
                    room = f"family_{family_id}"
                    await sio_server.emit('emergency-fall', {
                        'username': grandparent_username,
                        'user_id': grandparent_id,
                        'family_id': family_id,
                        'message': 'Emergency: Fall detected!'
                    }, room=room)
                    
                    # Logic for group call: Tell all caregivers to join a call
                    # We broadcast a 'start-emergency-call' event
                    await sio_server.emit('start-emergency-call', {
                        'initiator': grandparent_username,
                        'initiator_id': grandparent_id,
                        'family_id': family_id
                    }, room=room)
                    
                    # Wait 30 seconds before re-arming to prevent spam
                    await asyncio.sleep(30)
                
                await asyncio.sleep(0.1) # 10Hz sampling
            except Exception as e:
                print(f"Error in fall monitoring loop: {e}")
                await asyncio.sleep(5)
