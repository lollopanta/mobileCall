import smbus2
import os

def test_sensor():
    bus_number = 1
    device_address = 0x68
    PWR_MGMT_1 = 0x6B
    
    print(f"Testing I2C bus {bus_number} at address {hex(device_address)}...")
    
    try:
        bus = smbus2.SMBus(bus_number)
        # Try to read a byte to see if it responds
        who_am_i = bus.read_byte_data(device_address, 0x75)
        print(f"Sensor responded! WHO_AM_I register (0x75): {hex(who_am_i)}")
        
        print("Attempting to wake up sensor (PWR_MGMT_1 = 0)...")
        bus.write_byte_data(device_address, PWR_MGMT_1, 0)
        
        # Read back PWR_MGMT_1 to confirm
        pwr_val = bus.read_byte_data(device_address, PWR_MGMT_1)
        print(f"PWR_MGMT_1 is now: {hex(pwr_val)}")
        
        if pwr_val == 0:
            print("Sensor initialized successfully!")
        else:
            print(f"Warning: PWR_MGMT_1 is {hex(pwr_val)}, expected 0.")
            
    except Exception as e:
        print(f"Failed to communicate with sensor: {e}")

if __name__ == "__main__":
    test_sensor()
