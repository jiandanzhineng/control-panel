#!/usr/bin/env python3

""" Example of announcing a service (in this case, a fake HTTP server) """

import argparse
import logging
import socket
import time
from time import sleep

from zeroconf import IPVersion, ServiceInfo, Zeroconf, ServiceBrowser, ServiceListener
from typing import Dict, List


def get_host_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))  # 114.114.114.114也是dns地址
        ip = s.getsockname()[0]
    finally:
        s.close()
    return ip


def mdns_register():
    ip_version = IPVersion.V4Only
    desc = {'path': '/~paulsm/'}

    info = ServiceInfo(
        "_http._tcp.local.",
        "EasySmartSever._http._tcp.local.",
        addresses=[socket.inet_aton(get_host_ip())],
        port=80,
        properties=desc,
        server="easysmart.local.",
        host_ttl=60 * 60 * 60 * 60,  # 60*60 hours
        other_ttl=60 * 60 * 60 * 60,  # 60*60 hours
    )

    zeroconf = Zeroconf(ip_version=ip_version)
    print("Registration of a service")
    zeroconf.register_service(info)
    # try:
    #     while True:
    #         sleep(0.1)
    # except KeyboardInterrupt:
    pass


class MDNSServiceListener(ServiceListener):
    """mDNS服务监听器"""
    
    def __init__(self):
        self.services: Dict[str, ServiceInfo] = {}
    
    def add_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        """当发现新服务时调用"""
        info = zc.get_service_info(type_, name)
        if info:
            self.services[name] = info
            print(f"发现服务: {name}")
    
    def remove_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        """当服务移除时调用"""
        if name in self.services:
            del self.services[name]
            print(f"服务已移除: {name}")
    
    def update_service(self, zc: Zeroconf, type_: str, name: str) -> None:
        """当服务更新时调用"""
        info = zc.get_service_info(type_, name)
        if info:
            self.services[name] = info
            print(f"服务已更新: {name}")


def discover_mdns_services(service_types: List[str] = None, timeout: int = 5) -> Dict[str, ServiceInfo]:
    """探测当前网络中的所有mDNS服务
    
    Args:
        service_types: 要搜索的服务类型列表，如果为None则搜索常见服务类型
        timeout: 搜索超时时间（秒）
    
    Returns:
        Dict[str, ServiceInfo]: 发现的服务字典，键为服务名称，值为ServiceInfo对象
    """
    if service_types is None:
        # 常见的mDNS服务类型
        service_types = [
            "_http._tcp.local.",
            "_https._tcp.local.",
            "_ssh._tcp.local.",
            "_ftp._tcp.local.",
            "_printer._tcp.local.",
            "_airplay._tcp.local.",
            "_spotify-connect._tcp.local.",
            "_googlecast._tcp.local.",
            "_homekit._tcp.local.",
            "_hap._tcp.local.",
            "_smb._tcp.local.",
            "_afpovertcp._tcp.local.",
            "_device-info._tcp.local.",
            "_workstation._tcp.local."
        ]
    
    zeroconf = Zeroconf()
    listener = MDNSServiceListener()
    browsers = []
    
    try:
        # 为每种服务类型创建浏览器
        for service_type in service_types:
            browser = ServiceBrowser(zeroconf, service_type, listener)
            browsers.append(browser)
        
        print(f"开始搜索mDNS服务，超时时间: {timeout}秒...")
        time.sleep(timeout)
        
        print(f"\n发现 {len(listener.services)} 个服务:")
        for name, info in listener.services.items():
            addresses = [socket.inet_ntoa(addr) for addr in info.addresses]
            print(f"  服务名: {name}")
            print(f"  类型: {info.type}")
            print(f"  地址: {addresses}")
            print(f"  端口: {info.port}")
            print(f"  属性: {info.properties}")
            print(f"  服务器: {info.server}")
            print("-" * 50)
        
        return listener.services.copy()
    
    finally:
        # 清理资源
        for browser in browsers:
            browser.cancel()
        zeroconf.close()


def get_service_details(service_name: str, service_type: str) -> ServiceInfo:
    """获取特定服务的详细信息
    
    Args:
        service_name: 服务名称
        service_type: 服务类型
    
    Returns:
        ServiceInfo: 服务信息对象，如果未找到则返回None
    """
    zeroconf = Zeroconf()
    try:
        info = zeroconf.get_service_info(service_type, service_name)
        return info
    finally:
        zeroconf.close()
    # finally:
    #     print("Unregistering...")
    #     zeroconf.unregister_service(info)
    #     zeroconf.close()
    while True:
        time.sleep(1)



if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG)
    mdns_register()
    time.sleep(1)
    discover_mdns_services()
    while True:
        time.sleep(1)
