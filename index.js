(function () {
    'use strict';

    const SETTINGS_KEY = 'termux-shell-bridge-settings';
    const APPROVAL_KEY = 'termux-shell-bridge-approved';
    let registered = false;
    let lastChatKey = '';

    function getContext() {
        return window.SillyTavern?.getContext?.() || null;
    }

    function getSettings() {
        try {
            return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function saveSettings(url, token) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            url: url.replace(/\/+$/, ''),
            token
        }));
    }

    function getChatKey() {
        const ctx = getContext();
        if (!ctx) return 'unknown';

        return String(
            ctx.chatId ||
            ctx.chat?.[0]?.chat_id ||
            `${ctx.characterId || ''}:${ctx.groupId || ''}`
        );
    }

    function refreshSession() {
        const key = getChatKey();

        if (lastChatKey && key !== lastChatKey) {
            sessionStorage.removeItem(APPROVAL_KEY);
        }

        lastChatKey = key;
    }

    function isApproved() {
        refreshSession();
        return sessionStorage.getItem(APPROVAL_KEY) === '1';
    }

    function askApproval(command) {
        if (isApproved()) return true;

        const accepted = confirm(
            'LLM 请求执行 Termux Bash 命令：\n\n' +
            command +
            '\n\n' +
            '确认后，本次聊天会话内的后续命令将自动执行。'
        );

        if (accepted) {
            sessionStorage.setItem(APPROVAL_KEY, '1');
        }

        return accepted;
    }

    async function bridgeRequest(path, options = {}) {
        const cfg = getSettings();
        const url = (cfg.url || 'http://127.0.0.1:8765')
            .replace(/\/+$/, '');

        if (!cfg.token) {
            throw new Error('尚未设置 Termux Bridge Token');
        }

        const response = await fetch(url + path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.token}`,
                ...(options.headers || {})
            }
        });

        const text = await response.text();
        let data;

        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data;
    }

    function result(data) {
        return JSON.stringify(data, null, 2);
    }

    async function runShell(args) {
        const command = String(args.command || '');

        if (!command.trim()) {
            return result({ ok: false, error: '命令为空' });
        }

        if (!askApproval(command)) {
            return result({
                ok: false,
                cancelled: true,
                error: '用户拒绝执行命令'
            });
        }

        try {
            return result(await bridgeRequest('/shell', {
                method: 'POST',
                body: JSON.stringify({
                    command,
                    cwd: args.cwd || undefined,
                    timeout: args.timeout || 30000
                })
            }));
        } catch (error) {
            return result({
                ok: false,
                error: error.message
            });
        }
    }

    async function startJob(args) {
        const command = String(args.command || '');

        if (!command.trim()) {
            return result({ ok: false, error: '命令为空' });
        }

        if (!askApproval(`启动后台任务：\n${command}`)) {
            return result({
                ok: false,
                cancelled: true,
                error: '用户拒绝启动后台任务'
            });
        }

        try {
            return result(await bridgeRequest('/jobs/start', {
                method: 'POST',
                body: JSON.stringify({
                    command,
                    cwd: args.cwd || undefined
                })
            }));
        } catch (error) {
            return result({
                ok: false,
                error: error.message
            });
        }
    }

    async function getJobStatus(args) {
        const id = encodeURIComponent(String(args.job_id || ''));

        if (!id) {
            return result({ ok: false, error: '缺少任务 ID' });
        }

        try {
            return result(await bridgeRequest(`/jobs/${id}`));
        } catch (error) {
            return result({
                ok: false,
                error: error.message
            });
        }
    }

    async function stopJob(args) {
        const jobId = String(args.job_id || '');

        if (!jobId) {
            return result({ ok: false, error: '缺少任务 ID' });
        }

        if (!askApproval(`停止后台任务：${jobId}`)) {
            return result({
                ok: false,
                cancelled: true,
                error: '用户拒绝停止任务'
            });
        }

        try {
            return result(await bridgeRequest(
                `/jobs/${encodeURIComponent(jobId)}/stop`,
                {
                    method: 'POST',
                    body: '{}'
                }
            ));
        } catch (error) {
            return result({
                ok: false,
                error: error.message
            });
        }
    }

    function registerTools() {
        const ctx = getContext();

        if (!ctx || typeof ctx.registerFunctionTool !== 'function') {
            console.warn(
                '[Termux Shell Bridge] Function Calling API 不可用'
            );
            return;
        }

        if (registered) return;

        ctx.registerFunctionTool({
            name: 'termux_shell',
            displayName: 'Termux Shell',
            description:
                '在 Android 手机上的 Termux 中执行任意 Bash 命令。' +
                '可用于查看文件、运行脚本、安装软件、联网、编译和管理进程。',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: '要执行的完整 Bash 命令'
                    },
                    cwd: {
                        type: 'string',
                        description: '可选的工作目录'
                    },
                    timeout: {
                        type: 'integer',
                        description: '超时时间，单位毫秒，默认 30000'
                    }
                },
                required: ['command']
            },
            action: runShell,
            formatMessage: ({ command }) =>
                `执行 Termux：${String(command).slice(0, 100)}`,
            shouldRegister: () => true,
            stealth: false
        });

        ctx.registerFunctionTool({
            name: 'termux_start_job',
            displayName: 'Start Termux Job',
            description:
                '在 Termux 中启动后台 Bash 任务，适合下载、编译、服务器和长时间脚本。',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: '后台执行的 Bash 命令'
                    },
                    cwd: {
                        type: 'string',
                        description: '可选的工作目录'
                    }
                },
                required: ['command']
            },
            action: startJob,
            formatMessage: ({ command }) =>
                `启动后台任务：${String(command).slice(0, 100)}`,
            shouldRegister: () => true,
            stealth: false
        });

        ctx.registerFunctionTool({
            name: 'termux_job_status',
            displayName: 'Termux Job Status',
            description: '查询后台任务的状态和日志路径。',
            parameters: {
                type: 'object',
                properties: {
                    job_id: {
                        type: 'string',
                        description: '后台任务 ID'
                    }
                },
                required: ['job_id']
            },
            action: getJobStatus,
            formatMessage: ({ job_id }) =>
                `查询后台任务：${job_id}`,
            shouldRegister: () => true,
            stealth: false
        });

        ctx.registerFunctionTool({
            name: 'termux_stop_job',
            displayName: 'Stop Termux Job',
            description: '停止指定的后台任务。',
            parameters: {
                type: 'object',
                properties: {
                    job_id: {
                        type: 'string',
                        description: '后台任务 ID'
                    }
                },
                required: ['job_id']
            },
            action: stopJob,
            formatMessage: ({ job_id }) =>
                `停止后台任务：${job_id}`,
            shouldRegister: () => true,
            stealth: false
        });

        registered = true;
        console.log('[Termux Shell Bridge] 工具注册成功');
    }

    function createPanel() {
        if (document.getElementById('termux-shell-bridge-panel')) {
            return true;
        }

        const target =
            document.querySelector('#extensions_settings2') ||
            document.querySelector('#extensions_settings') ||
            document.querySelector('.extensions_settings');

        if (!target) return false;

        const s = getSettings();
        const panel = document.createElement('div');

        panel.id = 'termux-shell-bridge-panel';
        panel.className = 'inline-drawer';

        panel.innerHTML = `
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Termux Shell Bridge</b>
            </div>
            <div class="inline-drawer-content">
                <label>Bridge 地址</label>
                <input id="tsb-url" class="text_pole"
                    value="${s.url || 'http://127.0.0.1:8765'}">

                <label>Token</label>
                <input id="tsb-token" class="text_pole"
                    type="password" value="${s.token || ''}">

                <button id="tsb-test" class="menu_button">
                    测试连接
                </button>
                <button id="tsb-revoke" class="menu_button">
                    撤销当前聊天授权
                </button>

                <div id="tsb-status">正在初始化</div>
                <pre id="tsb-result"></pre>
            </div>
        `;

        target.appendChild(panel);

        const urlInput = document.getElementById('tsb-url');
        const tokenInput = document.getElementById('tsb-token');
        const status = document.getElementById('tsb-status');
        const output = document.getElementById('tsb-result');

        function save() {
            saveSettings(
                urlInput.value.trim(),
                tokenInput.value.trim()
            );
        }

        document.getElementById('tsb-test').onclick = async () => {
            save();

            try {
                output.textContent = result(
                    await bridgeRequest('/health')
                );
            } catch (error) {
                output.textContent = `连接失败：${error.message}`;
            }
        };

        document.getElementById('tsb-revoke').onclick = () => {
            sessionStorage.removeItem(APPROVAL_KEY);
            status.textContent = '已撤销当前聊天授权';
        };

        status.textContent = 'Termux Shell Bridge 已加载';
        return true;
    }

    function init() {
        createPanel();
        registerTools();
        refreshSession();
    }

    setInterval(() => {
        createPanel();
        registerTools();
        refreshSession();
    }, 1000);

    window.addEventListener('load', init);
    document.addEventListener('DOMContentLoaded', init);
    setTimeout(init, 1000);
})();
