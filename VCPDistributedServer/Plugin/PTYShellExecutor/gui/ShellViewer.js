// ShellViewer.js - PTYShellExecutor GUI 终端逻辑

// --- 全局变量 ---
let terminal = null;
let fitAddon = null;
let isConnected = false;

// --- DOM 元素引用 ---
const terminalContainer = document.getElementById('terminal-container');
const commandInput = document.getElementById('command-input');
const sendButton = document.getElementById('send-button');
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');

// --- 工具函数 ---

/**
 * 添加调试日志
 * @param {string} message - 日志消息
 * @param {string} type - 日志类型 (info, error, warn)
 */
function addDebugLog(message, type = 'info') {
    // 调试面板已移除，仅保留控制台输出
    console.log(`[DEBUG] ${type.toUpperCase()}: ${message}`);
}

/**
 * 获取 CSS 变量值
 * @param {string} variable - CSS 变量名
 * @returns {string} - 变量值
 */
function getCssVariable(variable) {
    return getComputedStyle(document.body).getPropertyValue(variable).trim();
}

/**
 * 更新连接状态显示
 * @param {boolean} connected - 是否已连接
 */
function updateConnectionStatus(connected) {
    isConnected = connected;
    if (statusDot) {
        statusDot.classList.toggle('disconnected', !connected);
    }
    if (statusText) {
        statusText.textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
    }
    if (sendButton) {
        sendButton.disabled = !connected;
    }
}

/**
 * 自适应终端尺寸
 */
function fitTerminal() {
    if (!fitAddon || !terminal) return;
    
    try {
        fitAddon.fit();
        // 发送新尺寸到后端
        if (window.shellAPI) {
            window.shellAPI.resize(terminal.cols, terminal.rows);
        }
    } catch (e) {
        console.error('Failed to fit terminal:', e);
    }
}

/**
 * 发送命令到 PTY
 */
function sendCommand() {
    if (!commandInput || !window.shellAPI) return;
    
    const command = commandInput.value;
    if (command.trim()) {
        // 在终端中显示命令（可选，因为 PTY 会回显）
        // terminal.write(command + '\r\n');
        
        // 发送完整命令（会自动添加换行符）
        window.shellAPI.sendCommand(command);
        
        // 清空输入框并聚焦
        commandInput.value = '';
        commandInput.focus();
        
        // 重置输入框高度
        commandInput.style.height = 'auto';
    }
}

/**
 * 自动调整输入框高度
 */
function autoResizeInput() {
    if (!commandInput) return;
    
    commandInput.style.height = 'auto';
    const newHeight = Math.min(commandInput.scrollHeight, 120);
    commandInput.style.height = newHeight + 'px';
}

/**
 * 应用主题到终端
 * @param {string} themeName - 主题名称 ('dark' 或 'light')
 */
function applyTheme(themeName) {
    if (!terminal) return;
    
    const isLight = themeName === 'light';
    
    // 切换 body 的主题类
    if (isLight) {
        document.body.classList.add('light-theme');
        document.body.setAttribute('data-theme', 'light');
    } else {
        document.body.classList.remove('light-theme');
        document.body.removeAttribute('data-theme');
    }
    
    // 延迟应用终端主题，确保 CSS 变量已更新
    setTimeout(() => {
        const theme = {
            background: 'transparent',
            foreground: getCssVariable('--primary-text') || (isLight ? '#4c4f69' : '#cdd6f4'),
            cursor: getCssVariable('--highlight-text') || (isLight ? '#1e66f5' : '#89b4fa'),
            cursorAccent: getCssVariable('--primary-bg') || (isLight ? '#eff1f5' : '#1e1e2e'),
            selectionBackground: getCssVariable('--accent-bg') || (isLight ? '#acb0be' : '#45475a'),
            selectionForeground: getCssVariable('--primary-text') || (isLight ? '#4c4f69' : '#cdd6f4'),
            black: getCssVariable('--tertiary-bg') || (isLight ? '#dce0e8' : '#11111b'),
            red: getCssVariable('--danger-color') || (isLight ? '#d20f39' : '#f38ba8'),
            green: getCssVariable('--success-color') || (isLight ? '#40a02b' : '#a6e3a1'),
            yellow: getCssVariable('--warning-color') || (isLight ? '#df8e1d' : '#f9e2af'),
            blue: getCssVariable('--button-bg') || (isLight ? '#1e66f5' : '#89b4fa'),
            magenta: getCssVariable('--highlight-text') || (isLight ? '#1e66f5' : '#89b4fa'),
            cyan: getCssVariable('--secondary-text') || (isLight ? '#6c6f85' : '#a6adc8'),
            white: getCssVariable('--primary-text') || (isLight ? '#4c4f69' : '#cdd6f4'),
            brightBlack: getCssVariable('--secondary-text') || (isLight ? '#6c6f85' : '#a6adc8'),
            brightRed: getCssVariable('--danger-hover-bg') || (isLight ? '#e64553' : '#eba0ac'),
            brightGreen: getCssVariable('--success-color') || (isLight ? '#40a02b' : '#a6e3a1'),
            brightYellow: getCssVariable('--warning-color') || (isLight ? '#df8e1d' : '#f9e2af'),
            brightBlue: getCssVariable('--button-hover-bg') || (isLight ? '#7287fd' : '#b4befe'),
            brightMagenta: getCssVariable('--highlight-text') || (isLight ? '#1e66f5' : '#89b4fa'),
            brightCyan: getCssVariable('--secondary-text') || (isLight ? '#6c6f85' : '#a6adc8'),
            brightWhite: getCssVariable('--primary-text') || (isLight ? '#4c4f69' : '#cdd6f4')
        };
        terminal.options.theme = theme;
        // 强制重新渲染整个终端
        terminal.refresh(0, terminal.rows - 1);
        // 额外触发一次尺寸调整以确保背景透明度等属性正确应用
        fitTerminal();
    }, 100);
}

// --- 终端初始化 ---

/**
 * 初始化终端
 */
async function initTerminal() {
    const nodeModulesPath = window.nodeModulesPath;
    addDebugLog(`nodeModulesPath: ${nodeModulesPath}`);
    
    // 动态加载 xterm.js 资源
    // 修复：使用正确的相对路径绕过 file:// 协议对绝对路径的加载限制
    // 经 find 排查，xterm 位于 ../../../node_modules/xterm (相对于 PTYShellExecutor 根目录)
    // 而 ShellViewer.html 位于 gui/ 目录下，所以需要再往上一层，即 ../../../../node_modules/xterm
    const xtermPath = '../../../../node_modules/xterm';
    const fitAddonPath = '../../../../node_modules/xterm-addon-fit';
    
    try {
        addDebugLog('Loading xterm.css via relative path...');
        loadCSS(xtermPath + '/css/xterm.css');
        
        addDebugLog('Loading xterm.js via relative path...');
        await loadScript(xtermPath + '/lib/xterm.js');
        
        // 尝试加载 fit addon
        try {
            addDebugLog('Loading addon-fit.js...');
            await loadScript(fitAddonPath + '/lib/xterm-addon-fit.js');
        } catch (e) {
            addDebugLog('Retrying addon-fit with scoped path...', 'warn');
            await loadScript('../../../../node_modules/@xterm/addon-fit/lib/addon-fit.js');
        }
    } catch (e) {
        addDebugLog(`Resource loading failed: ${e.target ? e.target.src || e.target.href : e.message || 'Unknown error'}`, 'error');
        throw e;
    }
    
    addDebugLog('Creating Terminal instance...');
    // 创建终端实例
    terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
        theme: {
            background: 'transparent',
            foreground: '#cdd6f4',
            cursor: '#f5e0dc',
            cursorAccent: '#1e1e2e',
            selectionBackground: '#45475a',
            black: '#45475a',
            red: '#f38ba8',
            green: '#a6e3a1',
            yellow: '#f9e2af',
            blue: '#89b4fa',
            magenta: '#f5c2e7',
            cyan: '#94e2d5',
            white: '#bac2de',
            brightBlack: '#585b70',
            brightRed: '#f38ba8',
            brightGreen: '#a6e3a1',
            brightYellow: '#f9e2af',
            brightBlue: '#89b4fa',
            brightMagenta: '#f5c2e7',
            brightCyan: '#94e2d5',
            brightWhite: '#a6adc8'
        },
        allowTransparency: true,
        scrollback: 10000,
        copyOnSelect: false
    });
    
    // 加载 FitAddon
    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    
    // 挂载终端
    terminal.open(terminalContainer);
    fitAddon.fit();
    
    // 设置事件监听
    setupTerminalEvents();
    setupIPCEvents();
    setupUIEvents();
    
    // 初始化尺寸
    setTimeout(() => {
        fitAddon.fit();
        if (window.shellAPI) {
            window.shellAPI.resize(terminal.cols, terminal.rows);
        }
    }, 100);
    
    // 通知主进程 GUI 已就绪
    if (window.shellAPI) {
        addDebugLog('Sending shell-gui-ready to main process...');
        window.shellAPI.notifyReady();
    } else {
        addDebugLog('shellAPI not found!', 'error');
    }
    
    // 初始状态设为未连接，等待主进程确认
    updateConnectionStatus(false);
    addDebugLog('Terminal initialized, waiting for pty-status...');
}

/**
 * 动态加载脚本
 * @param {string} src - 脚本路径
 * @returns {Promise}
 */
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

/**
 * 动态加载 CSS
 * @param {string} href - CSS 路径
 */
function loadCSS(href) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
}

// --- 事件设置 ---

/**
 * 设置终端事件
 */
function setupTerminalEvents() {
    if (!terminal) return;
    
    // 用户在终端中输入 -> 发送原始按键数据到 PTY
    terminal.onData((data) => {
        if (window.shellAPI) {
            window.shellAPI.sendInput(data);
        }
    });
    
    // 右键复制
    terminal.element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const selection = terminal.getSelection();
        if (selection && window.shellAPI) {
            window.shellAPI.copyToClipboard(selection);
            // 可选：显示复制成功提示
            showToast('已复制到剪贴板');
        }
    });
    
    // Ctrl+C 复制（当有选中文本时）
    terminal.attachCustomKeyEventHandler((arg) => {
        if (arg.ctrlKey && arg.code === 'KeyC' && arg.type === 'keydown') {
            const selection = terminal.getSelection();
            if (selection) {
                if (window.shellAPI) {
                    window.shellAPI.copyToClipboard(selection);
                }
                return false; // 阻止发送到 PTY
            }
        }
        return true;
    });
}

/**
 * 设置 IPC 事件监听
 */
function setupIPCEvents() {
    if (!window.shellAPI) {
        addDebugLog('shellAPI not available for IPC setup', 'error');
        updateConnectionStatus(false);
        return;
    }
    
    addDebugLog('Setting up IPC event listeners...');

    // 接收终端数据
    window.shellAPI.onData((data) => {
        if (terminal && data) {
            terminal.write(data);
        }
    });
    
    // 清屏事件
    window.shellAPI.onClear(() => {
        if (terminal) {
            terminal.clear();
        }
    });
    
    // 主题变化
    window.shellAPI.onThemeInit((data) => {
        if (data && data.themeName) {
            applyTheme(data.themeName);
        }
    });

    // 监听 PTY 连接状态
    window.shellAPI.onStatus((status) => {
        addDebugLog(`Received pty-status: ${JSON.stringify(status)}`, 'info');
        updateConnectionStatus(status.connected);
    });
}

/**
 * 设置 UI 事件
 */
function setupUIEvents() {
    // 窗口大小变化
    window.addEventListener('resize', () => {
        setTimeout(fitTerminal, 0);
    });
    
    // 发送按钮点击
    if (sendButton) {
        sendButton.addEventListener('click', sendCommand);
    }
    
    // 输入框事件
    if (commandInput) {
        // 按键事件
        commandInput.addEventListener('keydown', (event) => {
            // Enter 发送命令（Shift+Enter 换行）
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendCommand();
            }
        });
        
        // 输入时自动调整高度
        commandInput.addEventListener('input', autoResizeInput);
    }
    
    // 标题栏按钮
    const minimizeBtn = document.querySelector('.btn-minimize');
    const maximizeBtn = document.querySelector('.btn-maximize');
    const closeBtn = document.querySelector('.btn-close');
    
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            if (window.shellAPI) window.shellAPI.minimizeWindow();
        });
    }
    
    if (maximizeBtn) {
        maximizeBtn.addEventListener('click', () => {
            if (window.shellAPI) window.shellAPI.maximizeWindow();
        });
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            if (window.shellAPI) window.shellAPI.closeWindow();
        });
    }
}


/**
 * 显示 Toast 提示
 * @param {string} message - 提示消息
 */
function showToast(message) {
    // 创建 toast 元素
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--accent-bg);
        color: var(--primary-text);
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 12px;
        z-index: 9999;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // 显示
    setTimeout(() => toast.style.opacity = '1', 10);
    
    // 隐藏并移除
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    addDebugLog('DOM Content Loaded');
    initTerminal().catch((err) => {
        const errorMsg = err ? (err.message || JSON.stringify(err)) : 'Unknown error';
        addDebugLog(`Initialization error: ${errorMsg}`, 'error');
        updateConnectionStatus(false);
    });
});