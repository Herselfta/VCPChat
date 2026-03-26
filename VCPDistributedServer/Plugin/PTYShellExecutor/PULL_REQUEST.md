# Pull Request: PTYShellExecutor 本地 Shell 执行插件

## 概述

新增 PTYShellExecutor 插件，为 VCPChat 提供 Linux 桌面环境下的本地 Shell 命令执行能力。

## 解决的问题

现有的 LinuxShellExecutor 专注于 SSH 远程执行，但在以下场景存在不足：

1. 本地开发环境 - 用户在本机运行 VCPChat 时，需要执行本地命令
2. 会话状态保持 - SSH 每次连接独立，无法保持环境变量和工作目录
3. 长任务管理 - 缺乏对本地长时间任务的异步管理能力

## 新增功能

### 核心能力

- PTY 持久会话 - 使用 node-pty 创建真实的伪终端，保持会话状态
- 多 Shell 支持 - 自动检测 fish/zsh/bash，按优先级选择
- 同步/异步双模式 - 短命令同步返回，长任务后台托管
- 智能输出清理 - 自动过滤 ANSI 序列、Shell Integration 标记

### 异步任务系统

- 任务启动后立即返回 taskId
- 支持查询、取消、列出任务
- 状态持久化至磁盘（7 天自动清理）
- 输出限制 5MB 防止内存溢出

### GUI 终端

- 内置 Electron 窗口实时显示命令执行
- 主题自动跟随 VCPChat 设置
- 支持终端尺寸调整

## 文件清单

- PTYShellExecutor.js - 主逻辑 (36KB)
- plugin-manifest.json - 插件清单
- config.env - 配置文件
- README.md - 使用文档
- gui/ShellViewer.html - 终端界面
- gui/preload.js - Electron 预加载脚本
- state/ - 任务状态存储目录

## 技术实现

### 依赖项

- node-pty - PTY 创建（复用主程序依赖）
- electron - GUI 窗口（复用主程序依赖）
- chokidar - 配置文件监听（复用主程序依赖）

### 关键设计

1. 边界检测机制 - 使用 UUID 边界标记区分命令输出
2. 输出清理管线 - 多层正则过滤 ANSI/OSC/CSI 序列
3. 任务持久化 - JSON 文件存储，支持进程重启后恢复查询

## 已知限制

1. 不支持交互式程序（less/vim）- 建议使用管道绕过
2. 仅限 Linux 环境
3. GUI 功能依赖 Electron

## 测试情况

- 同步执行基础命令 (ls, pwd, echo) - 通过
- 异步任务启动/查询/取消 - 通过
- Fish shell 输出清理 - 通过
- 任务持久化与恢复 - 通过
- GUI 窗口主题同步 - 通过

Authors: Piko and 十一
Date: 2026-01-22