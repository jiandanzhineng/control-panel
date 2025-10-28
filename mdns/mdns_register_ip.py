#!/usr/bin/env python3

"""根据传入IP注册mDNS服务（不复用原方法，除IP外保持一致）"""

import argparse
import logging
import socket
import time
from zeroconf import IPVersion, ServiceInfo, Zeroconf


def mdns_register_with_ip(ip: str):
    """使用提供的IPv4地址注册mDNS服务。

    除了IP来源不同（使用传入参数），其余行为与现有的 mdns_register 方法一致。
    """
    ip_version = IPVersion.V4Only
    desc = {'path': '/~paulsm/'}

    info = ServiceInfo(
        "_http._tcp.local.",
        "EasySmartSever._http._tcp.local.",
        addresses=[socket.inet_aton(ip)],
        port=80,
        properties=desc,
        server="easysmart.local.",
        host_ttl=60 * 60 * 60 * 60,  # 60*60 hours
        other_ttl=60 * 60 * 60 * 60,  # 60*60 hours
    )

    zeroconf = Zeroconf(ip_version=ip_version)
    print("Registration of a service")
    zeroconf.register_service(info)
    # 与原方法一致：不复用、无循环与注销逻辑
    pass


if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG)
    parser = argparse.ArgumentParser(description="根据指定IPv4地址注册mDNS服务")
    parser.add_argument("--ip", required=True, help="要注册的IPv4地址，例如 192.168.1.100")
    args = parser.parse_args()

    mdns_register_with_ip(args.ip)
    # 保持进程常驻，使mDNS注册持续生效
    while True:
        time.sleep(1)