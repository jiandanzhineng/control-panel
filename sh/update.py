#!/usr/bin/env python3
"""
Electron应用更新镜像脚本
从GitHub releases下载最新版本文件并创建本地镜像
"""

import os
import sys
import yaml
import requests
import shutil
import zipfile
from pathlib import Path
from urllib.parse import urljoin


class UpdateMirror:
    def __init__(self, output_dir="./mirror", base_url="https://github.com/jiandanzhineng/electron-client/releases/latest/download/"):
        """
        初始化更新镜像工具
        
        Args:
            output_dir (str): 输出目录路径
        """
        self.base_url = base_url
        self.latest_yml_url = urljoin(self.base_url, "latest.yml")
        self.output_dir = Path(output_dir)
        self.session = requests.Session()
        
        # 创建输出目录
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
    def download_file(self, url, local_path):
        """
        下载文件到本地
        
        Args:
            url (str): 文件URL
            local_path (Path): 本地保存路径
        """
        print(f"正在下载: {url}")
        
        try:
            response = self.session.get(url, stream=True)
            response.raise_for_status()
            
            # 获取文件大小
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0
            
            with open(local_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        
                        # 显示下载进度
                        if total_size > 0:
                            progress = (downloaded / total_size) * 100
                            print(f"\r下载进度: {progress:.1f}%", end='', flush=True)
            
            print(f"\n✓ 下载完成: {local_path.name}")
            return True
            
        except requests.RequestException as e:
            print(f"\n✗ 下载失败: {e}")
            return False
    
    def parse_latest_yml(self, yml_content):
        """
        解析latest.yml文件内容
        
        Args:
            yml_content (str): YAML文件内容
            
        Returns:
            dict: 解析后的配置信息
        """
        try:
            config = yaml.safe_load(yml_content)
            return {
                'version': config.get('version'),
                'filename': config.get('path'),
                'sha512': config.get('sha512'),
                'release_date': config.get('releaseDate')
            }
        except yaml.YAMLError as e:
            print(f"✗ YAML解析失败: {e}")
            return None
    
    def clean_exe_files(self):
        """
        清理输出目录中的所有exe文件
        """
        print("清理旧的exe文件...")
        exe_files = list(self.output_dir.glob("*.exe"))
        
        if not exe_files:
            print("✓ 没有找到需要清理的exe文件")
            return True
        
        cleaned_count = 0
        for exe_file in exe_files:
            try:
                exe_file.unlink()
                print(f"✓ 已删除: {exe_file.name}")
                cleaned_count += 1
            except Exception as e:
                print(f"✗ 删除失败 {exe_file.name}: {e}")
                return False
        
        print(f"✓ 共清理了 {cleaned_count} 个exe文件")
        return True
    
    def create_zip_file(self, exe_file_path):
        """
        将exe文件压缩到zip文件中
        
        Args:
            exe_file_path (Path): exe文件路径
        """
        zip_path = self.output_dir / "EasySmart-Setup.zip"
        
        try:
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED,compresslevel=6) as zipf:
                # 添加exe文件到zip中，使用原始文件名
                zipf.write(exe_file_path, exe_file_path.name)
            
            # 获取压缩后的文件大小
            zip_size_mb = zip_path.stat().st_size / (1024 * 1024)
            original_size_mb = exe_file_path.stat().st_size / (1024 * 1024)
            compression_ratio = (1 - zip_size_mb / original_size_mb) * 100
            
            print(f"✓ 创建压缩文件: EasySmart-Setup.zip")
            print(f"  原始大小: {original_size_mb:.1f} MB")
            print(f"  压缩大小: {zip_size_mb:.1f} MB")
            print(f"  压缩率: {compression_ratio:.1f}%")
            
            return True
            
        except Exception as e:
            print(f"✗ 创建压缩文件失败: {e}")
            return False
    
    def download_control_panel(self):
        """
        下载control-panel仓库的stable分支
        """
        control_panel_url = "https://codeload.github.com/jiandanzhineng/control-panel/zip/refs/heads/stable"
        stable_zip_path = self.output_dir / "control-panel-stable.zip"
        
        print("下载control-panel仓库stable分支...")
        
        if not self.download_file(control_panel_url, stable_zip_path):
            print("✗ 无法下载control-panel仓库")
            return False
        
        # 显示文件信息
        file_size_mb = stable_zip_path.stat().st_size / (1024 * 1024)
        print(f"✓ control-panel下载完成: stable.zip ({file_size_mb:.1f} MB)")
        
        return True
    
    def run(self):
        """
        执行镜像更新流程
        """
        print("=== Electron应用更新镜像工具 ===\n")
        
        # 1. 清理旧的exe文件
        print("1. 清理旧的exe文件...")
        if not self.clean_exe_files():
            print("✗ 清理exe文件失败")
            return False
        
        # 2. 下载latest.yml文件
        print("\n2. 下载latest.yml文件...")
        latest_yml_path = self.output_dir / "latest.yml"
        
        if not self.download_file(self.latest_yml_url, latest_yml_path):
            print("✗ 无法下载latest.yml文件")
            return False
        
        # 3. 解析latest.yml文件
        print("\n3. 解析latest.yml文件...")
        try:
            with open(latest_yml_path, 'r', encoding='utf-8') as f:
                yml_content = f.read()
        except Exception as e:
            print(f"✗ 读取latest.yml失败: {e}")
            return False
        
        config = self.parse_latest_yml(yml_content)
        if not config:
            return False
        
        print(f"✓ 版本: {config['version']}")
        print(f"✓ 文件名: {config['filename']}")
        
        # 4. 下载exe安装文件
        print(f"\n4. 下载安装文件: {config['filename']}...")
        exe_url = urljoin(self.base_url, config['filename'])
        exe_path = self.output_dir / config['filename']
        
        if not self.download_file(exe_url, exe_path):
            print("✗ 无法下载安装文件")
            return False
        
        # 5. 创建重命名副本
        print("\n5. 创建重命名副本...")
        generic_name = "EasySmart-Setup.exe"
        generic_path = self.output_dir / generic_name
        
        try:
            shutil.copy2(exe_path, generic_path)
            print(f"✓ 创建副本: {generic_name}")
        except Exception as e:
            print(f"✗ 创建副本失败: {e}")
            return False
        
        # 6. 创建压缩文件
        print("\n6. 创建压缩文件...")
        if not self.create_zip_file(exe_path):
            print("✗ 创建压缩文件失败")
            return False
        
        # 7. 下载control-panel仓库
        print("\n7. 下载control-panel仓库...")
        if not self.download_control_panel():
            print("✗ 下载control-panel仓库失败")
            return False
        
        print(f"\n=== 镜像更新完成 ===")
        print(f"输出目录: {self.output_dir.absolute()}")
        print(f"文件列表:")
        for file_path in self.output_dir.iterdir():
            if file_path.is_file():
                size_mb = file_path.stat().st_size / (1024 * 1024)
                print(f"  - {file_path.name} ({size_mb:.1f} MB)")
        
        return True


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Electron应用更新镜像工具")
    parser.add_argument(
        "-o", "--output", 
        default="./mirror",
        help="输出目录路径 (默认: ./mirror)"
    )
    
    args = parser.parse_args()
    output_dir = Path(args.output).absolute()
    
    # 创建并运行镜像工具
    mirror = UpdateMirror(output_dir=output_dir)
    success = mirror.run()
    control_panel_dir = output_dir / "control-panel"
    control_panel_baseurl = "https://github.com/jiandanzhineng/control-panel/releases/latest/download/"
    cp_mirror = UpdateMirror(output_dir=control_panel_dir, base_url=control_panel_baseurl)
    cp_success = cp_mirror.run()
    if cp_success:
        print(f"✓ control-panel目录更新完成: {control_panel_dir}")
    else:
        print("✗ control-panel目录更新失败")

    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()