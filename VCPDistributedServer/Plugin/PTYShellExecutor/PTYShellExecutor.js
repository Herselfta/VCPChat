/**
 * PTYShellExecutor.entry.js (引导层)
 * 负责极简加载、错误捕获与环境诊断
 */
const PluginErrorReporter = require('./PluginErrorReporter');

const reporter = new PluginErrorReporter('PTYShellExecutor');
reporter.installProcessHooks();

let impl = null;

try {
    // 尝试加载主体逻辑
    impl = require('./PTYShellExecutor.impl');
} catch (err) {
    // 加载期异常捕获
    reporter.capture('load', err, {
        hint: "主体逻辑加载失败，可能是原生依赖(node-pty)缺失或版本不匹配",
        requirePath: './PTYShellExecutor.impl'
    });
}

/**
 * 统一导出 processToolCall
 */
async function processToolCall(args) {
    if (!impl) {
        return {
            status: 'error',
            message: '插件加载失败，请检查本地诊断报告。',
            diagnostics: 'Check VCPDistributedServer/Plugin/PTYShellExecutor/reports/'
        };
    }

    if (typeof impl.processToolCall !== 'function') {
        reporter.capture('exportCheck', new Error('Missing processToolCall function'), {
            exports: Object.keys(impl)
        });
        return {
            status: 'error',
            message: '插件接口异常：缺失 processToolCall'
        };
    }

    try {
        // 运行期异常包装
        return await impl.processToolCall(args);
    } catch (err) {
        reporter.capture('processToolCall', err, { args });
        throw err; // 继续抛出让 VCP 框架感知
    }
}

/**
 * 统一导出 cleanup
 */
function cleanup() {
    if (impl && typeof impl.cleanup === 'function') {
        try {
            impl.cleanup();
        } catch (err) {
            reporter.capture('cleanup', err);
        }
    }
}

module.exports = { processToolCall, cleanup };