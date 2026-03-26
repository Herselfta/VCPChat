const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * PluginErrorReporter - 插件统一错误报告器
 * 用于捕获、结构化并持久化插件运行期及加载期的异常
 */
class PluginErrorReporter {
    constructor(pluginName, options = {}) {
        this.pluginName = pluginName;
        // P0: 报告目录改为插件内 reports/
        this.reportDir = options.reportDir || path.join(__dirname, 'reports');
        this.maxReports = options.maxReports || 50;
        this.maxAgeDays = options.maxAgeDays || 7;
        this.includeCommand = process.env.ERROR_REPORT_INCLUDE_COMMAND === 'true';
        
        this.ensureReportDir();
    }

    ensureReportDir() {
        try {
            if (!fs.existsSync(this.reportDir)) {
                fs.mkdirSync(this.reportDir, { recursive: true });
            }
        } catch (e) {
            console.error(`[PluginErrorReporter] Failed to create report dir: ${e.message}`);
        }
    }

    /**
     * 脱敏处理 - P2: 更保守的策略
     */
    sanitize(data) {
        if (!data) return data;
        if (typeof data === 'string') {
            return this.sanitizeString(data);
        }
        if (Array.isArray(data)) return data.map(item => this.sanitize(item));
        if (typeof data === 'object') {
            const sanitized = {};
            for (const key in data) {
                const lowerKey = key.toLowerCase();
                // 默认隐藏命令/参数/输入，除非显式开启
                if (['command', 'args', 'input', 'cmd'].includes(lowerKey) && !this.includeCommand) {
                    sanitized[key] = '[HIDDEN - set ERROR_REPORT_INCLUDE_COMMAND=true to reveal]';
                } else if (['password', 'secret', 'token', 'key', 'auth', 'credential'].some(s => lowerKey.includes(s))) {
                    sanitized[key] = '[REDACTED]';
                } else {
                    sanitized[key] = this.sanitize(data[key]);
                }
            }
            return sanitized;
        }
        return data;
    }

    /**
     * 字符串级脱敏
     */
    sanitizeString(str) {
        if (!str || typeof str !== 'string') return str || '';
        return str
            // Bearer token
            .replace(/Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, 'Bearer ***')
            // Authorization header
            .replace(/Authorization[:\s]+[^\s\n"']+/gi, 'Authorization: ***')
            // 通用 key=value 模式
            .replace(/(api_key|token|password|auth|secret|key)[=:]\s*[^\s&"'\n]+/gi, '$1=***')
            // URL 中的敏感参数
            .replace(/([?&](api_key|token|secret|password|key)=)[^&\s]*/gi, '$1***')
            .substring(0, 500); // 更严格的长度限制
    }

    /**
     * 安全的 JSON 序列化 - P1: 防止循环引用导致 capture 自身崩溃
     */
    safeStringify(obj, space = 2) {
        const seen = new WeakSet();
        return JSON.stringify(obj, (key, value) => {
            // 跳过函数
            if (typeof value === 'function') return '[Function]';
            // 跳过 Buffer
            if (Buffer.isBuffer(value)) return `[Buffer: ${value.length} bytes]`;
            // 处理循环引用
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) return '[Circular]';
                seen.add(value);
                // 跳过 Electron 对象
                if (value.constructor && ['BrowserWindow', 'WebContents', 'Terminal'].includes(value.constructor.name)) {
                    return `[${value.constructor.name}]`;
                }
            }
            // 截断超长字符串
            if (typeof value === 'string' && value.length > 1000) {
                return value.substring(0, 1000) + `... [truncated, total ${value.length} chars]`;
            }
            return value;
        }, space);
    }

    /**
     * 捕获并记录错误
     */
    capture(phase, err, context = {}) {
        const timestamp = new Date().toISOString();
        const reportId = `${timestamp.replace(/[:.]/g, '-')}_pid${process.pid}.json`;
        const filePath = path.join(this.reportDir, reportId);

        // 只保留 context 的摘要，避免大对象
        const contextSummary = this.extractContextSummary(context);

        const report = {
            timestamp,
            pluginName: this.pluginName,
            phase,
            error: {
                name: err.name || 'Error',
                message: err.message,
                stack: err.stack,
                code: err.code
            },
            environment: {
                pid: process.pid,
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.versions.node,
                // P0: 补回对 node-pty ABI 排查关键的版本信息
                electronVersion: process.versions.electron || null,
                modules: process.versions.modules || null, // Node ABI 版本
                v8Version: process.versions.v8 || null,
                cwd: process.cwd()
            },
            context: this.sanitize(contextSummary)
        };

        try {
            fs.writeFileSync(filePath, this.safeStringify(report));
            console.error(`[PluginErrorReporter] Critical error captured in ${phase}. Report saved to: ${filePath}`);
            this.rotate();
        } catch (e) {
            console.error(`[PluginErrorReporter] Failed to save report: ${e.message}`);
        }
        return report;
    }

    /**
     * 提取 context 摘要，避免保存大对象
     */
    extractContextSummary(context) {
        if (!context || typeof context !== 'object') return context;
        const summary = {};
        // P0: 确保 _processLevelHookNote 能被保留到报告中
        const safeKeys = ['action', 'taskId', 'shell', 'newSession', 'phase', 'hint', 'requirePath', 'exports', '_processLevelHookNote'];
        for (const key of safeKeys) {
            if (key in context) {
                summary[key] = context[key];
            }
        }
        // 如果有 args，只保留关键字段
        if (context.args && typeof context.args === 'object') {
            summary.argsKeys = Object.keys(context.args);
            if (context.args.action) summary.action = context.args.action;
            if (context.args.taskId) summary.taskId = context.args.taskId;
        }
        return summary;
    }

    /**
     * 包装异步函数
     */
    wrapAsync(fn, phase, contextProvider) {
        return async (...args) => {
            try {
                return await fn(...args);
            } catch (err) {
                const context = typeof contextProvider === 'function' ? contextProvider(...args) : { args };
                this.capture(phase, err, context);
                throw err;
            }
        };
    }

    /**
     * 注册进程钩子 - P1: 幂等安装，防止重复注册
     */
    installProcessHooks() {
        // 使用全局标志确保只安装一次
        const hookKey = `__PluginErrorReporter_${this.pluginName}_HooksInstalled`;
        if (globalThis[hookKey]) {
            console.log(`[PluginErrorReporter] Process hooks already installed for ${this.pluginName}, skipping.`);
            return;
        }
        globalThis[hookKey] = true;

        process.on('uncaughtException', (err) => {
            // P1: 标明这是进程级钩子捕获，不一定来自本插件
            this.capture('uncaughtException', err, {
                _processLevelHookNote: '此异常由进程级 uncaughtException 钩子捕获，可能来自宿主进程或其他模块，不一定源于本插件调用链'
            });
            // 注意：通常 uncaughtException 后应该退出，但作为插件可能需要由宿主决定
        });
        process.on('unhandledRejection', (reason, promise) => {
            const err = reason instanceof Error ? reason : new Error(String(reason));
            // P1: 标明这是进程级钩子捕获，不一定来自本插件
            this.capture('unhandledRejection', err, {
                _processLevelHookNote: '此异常由进程级 unhandledRejection 钩子捕获，可能来自宿主进程或其他模块，不一定源于本插件调用链'
            });
        });
        console.log(`[PluginErrorReporter] Process hooks installed for ${this.pluginName}`);
    }

    /**
     * 轮转清理旧报告
     */
    rotate() {
        try {
            const files = fs.readdirSync(this.reportDir)
                .filter(f => f.endsWith('.json'))
                .map(f => ({
                    name: f,
                    path: path.join(this.reportDir, f),
                    mtime: fs.statSync(path.join(this.reportDir, f)).mtime
                }))
                .sort((a, b) => b.mtime - a.mtime);

            const now = Date.now();
            const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;

            files.forEach((file, index) => {
                const isTooOld = (now - file.mtime) > maxAgeMs;
                const isTooMany = index >= this.maxReports;
                if (isTooOld || isTooMany) {
                    fs.unlinkSync(file.path);
                }
            });
        } catch (e) {
            console.error(`[PluginErrorReporter] Rotation failed: ${e.message}`);
        }
    }
}

module.exports = PluginErrorReporter;