# 串口控制虚拟心率带：面板占着唯一 BLE 连接时也能改场景。
# 流程：Ctrl-C 打断主循环（BLE 连接不受影响）→ 执行命令 → 恢复 hrm.run()。
# 用法：python serial_cmd.py "hr=120"      （默认 COM17，环境变量 HRM_PORT 可改；不带参数 = status）
# 注意：DTR/RTS 必须保持 False，否则板子被按在复位态。
import os
import sys
import time

import serial


def read_for(port, seconds):
    end = time.time() + seconds
    buf = b''
    while time.time() < end:
        buf += port.read(512)
    return buf.decode('utf-8', 'replace')


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    port = serial.Serial()
    port.port = os.environ.get('HRM_PORT', 'COM17')
    port.baudrate = 115200
    port.dtr = False
    port.rts = False
    port.timeout = 0.2
    port.open()
    try:
        port.write(b'\x03\x03')
        read_for(port, 1.0)
        port.write(b'import hrm\r')
        read_for(port, 0.5)
        port.write(('print(hrm.cmd(%r))\r' % cmd).encode())
        out = read_for(port, 1.0)
        port.write(b'hrm.run()\r')
        read_for(port, 0.5)
    finally:
        port.close()
    lines = [l for l in out.splitlines() if l.strip() and not l.startswith('>>>') and 'hrm.cmd' not in l]
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
