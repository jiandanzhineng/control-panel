# ESP32-C3 MicroPython：模拟役次元杯 GATT（FF40/FF41/FF42）
import bluetooth
from micropython import const

_IRQ_GATTS_WRITE = const(3)
SVC = bluetooth.UUID(0xFF40)
RX = (bluetooth.UUID(0xFF41), bluetooth.FLAG_WRITE | bluetooth.FLAG_WRITE_NO_RESPONSE)
TX = (bluetooth.UUID(0xFF42), bluetooth.FLAG_NOTIFY | bluetooth.FLAG_READ)
UART = (SVC, (RX, TX))


class YcyFjbMock:
    def __init__(self):
        self.ble = bluetooth.BLE()
        self.ble.active(True)
        self.ble.config(gap_name="YCY-FJB-03")
        self.ble.irq(self._irq)
        ((self.rx, self.tx),) = self.ble.gatts_register_services((UART,))
        self.ble.gatts_set_buffer(self.rx, 64)
        self.last = b""
        self._adv()

    def _adv(self):
        name = b"YCY-FJB-03"
        adv = bytearray()
        adv += bytes((2, 0x01, 0x06))
        adv += bytes((1 + len(name), 0x09)) + name
        adv += bytes((3, 0x03, 0x40, 0xFF))
        self.ble.gap_advertise(100000, adv_data=bytes(adv))

    def _irq(self, event, data):
        if event == _IRQ_GATTS_WRITE:
            conn_handle, _attr = data
            self.last = self.ble.gatts_read(self.rx)
            try:
                self.ble.gatts_notify(conn_handle, self.tx, self.last)
            except OSError:
                pass


YcyFjbMock()
