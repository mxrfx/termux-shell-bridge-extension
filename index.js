(function () {
    'use strict';

    const KEY = 'termux-shell-bridge-settings';
    const APPROVAL = 'termux-shell-bridge-approved';

    let registered = false;
    let lastChat = '';

    function ctx() {
        return window.SillyTavern?.getContext?.() || null;
    }

    function settings() {
        try {
            return JSON.parse(localStorage.getItem(KEY) || '{}');
        } catch {
            return {};
        }
    }

    function saveSettings(url, token, mode) {
        localStorage.setItem(KEY, JSON.stringify({
            url: url.replace(/\/+$/, ''),
            token,
            mode
        }));
    }

    function config() {
        const value = settings();

        return {
            url: (value.url || 'http://127.0.0.1:8765')
                .replace(/\/+$/, ''),
            token: value.token || '',
            mode: value.mode || 'ask'
        };
    }

    function chatKey() {
        const value = ctx();

        if (!value) return 'unknown';

        return [
            value.characterId ?? '',
            value.groupId ?? '',
            value.chatId ?? '',
            Array.isArray(value.chat)
                ? value.chat.length
                : ''
        ].join(':');
    }

    function refreshChat() {
        const key = chatKey();

        if (lastChat && key !== lastChat) {
            sessionStorage.removeItem(APPROVAL);
        }

        lastChat = key;
    }

    function approved() {
        refreshChat();
        return sessionStorage.getItem(APPROVAL) === '1';
    }

    function ask(command) {
        const value = config();

        if (value.mode === 'trust' && approved()) {
            return true;
        }

        const ok = window.confirm(
            'LLM 请求执行 Termux Bash 命令：\n\n' +
            command +
            '\n\n' +
            '允许后，本次聊天会话内后续命令将自动执行。'
        );

        if (ok) {
            sessionStorage.setItem(APPROVAL, '1');
            setStatus('当前聊天：自动执行已授权');
        }

        return ok;
    }

    async function request(path, options = {}) {
        const value = config();

        if (!value.token) {
            throw new Error('未设置 Bridge Token');
        }

        const response = await fetch(value.url + path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${value.token}`,
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

    function stringify(value) {
        return JSON.stringify(value, null, 2);
    }

    function denied(message) {
        return stringify({
            ok: false,
            cancelled: true,
            error: message
        });
    }

    async function shell(args) {
        const command = String(args.command || '').trim();

        if (!command) {
            return stringify({
                ok: false,
                error: '命令为空'
            });
        }

        if (!ask(command)) {
            return denied('用户拒绝执行命令');
        }

        try {
            return stringify(await request('/shell', {
                method: 'POST',
                body: JSON.stringify({
                    command,
                    cwd: args.cwd || undefined,
                    timeout: args.timeout || 30000
                })
            }));
        } catch (error) {
            return stringify({
                ok: false,
                error: error.message
            });
        }
    }

    async function startJob(args) {
        const command = String(args.command || '').trim();

        if (!command) {
            return stringify({
                ok: false,
                error: '命令为空'
            });
        }

        if (!ask(`启动后台任务：\n${command}`)) {
            return denied('用户拒绝启动后台任务');
        }

        try {
            return stringify(await request('/jobs/start', {
                method: 'POST',
                body: JSON.stringify({
                    command,
                    cwd: args.cwd || undefined
                })
            }));
        } catch (error) {
            return stringify({
                ok: false,
                error: error.message
            });
        }
    }

    async function listJobs() {
        try {
            return stringify(await request('/jobs'));
        } catch (error) {
            return stringify({
                ok: false,
                error: error.message
            });
        }
    }

    async function jobStatus(args) {
        const id = String(args.job_id || '').trim();

        if (!id) {
            return stringify({
                ok: false,
                error: '缺少任务 ID'
            });
        }

        try {
            return stringify(await request(
                `/jobs/${encodeURIComponent(id)}`
            ));
        } catch (error) {
            return stringify({
                ok: false,
                error: error.message
            });
        }
    }

    async function stopJob(args) {
        const id = String(args.job_id || '').trim();

        if (!id) {
            return stringify({
                ok: false,
                error: '缺少任务 ID'
            });
        }

        if (!ask(`停止后台任务：${id}`)) {
            return denied('用户拒绝停止任务');
        }

        try {
            return stringify(await request(
                `/jobs/${encodeURIComponent(id)}/stop`,
                {
                    method: 'POST',
                    body: '{}'
                }
            ));
        } catch (error) {
            return stringify({
                ok: false,
                error: error.message
            });
        }
    }

    async function stopAllJobs() {
        if (!ask('终止所有后台任务')) {
            return denied('用户拒绝终止全部任务');
        }

        try {
            return stringify(await request('/jobs/stop-all', {
                method: 'POST',
                body: '{}'
            }));
        } catch (error) {
            return stringify({
                ok: false,
                error: error.message
            });
        }
    }

    function registerTool(definition) {
        const value = ctx();

        if (
            value &&
            typeof value.registerFunctionTool === 'function'
        ) {
            value.registerFunctionTool(definition);
            return true;
        }

        return false;
    }

    function registerTools() {
        if (registered) return true;

        const value = ctx();

        if (
            !value ||
            typeof value.registerFunctionTool !== 'function'
        ) {
            return false;
        }

        registerTool({
            name: 'termux_shell',
            displayName: 'Termux Shell',
            description:
                '在 Android 手机上的 Termux 中执行任意 Bash 命令。' +
                '可以读写文件、联网、安装软件、运行脚本、编译和管理进程。',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: '完整的 Bash 命令'
                    },
                    cwd: {
                        type: 'string',
                        description: '可选工作目录'
                    },
                    timeout: {
                        type: 'integer',
                        description: '超时时间，单位毫秒'
                    }
                },
                required: ['command']
            },
            action: shell,
            formatMessage: ({ command }) =>
                `Termux Shell：${String(command).slice(0, 100)}`,
            shouldRegister: () => true,
            stealth: false
        });

        registerTool({
            name: 'termux_start_job',
            displayName: 'Start Termux Job',
            description:
                '启动 Termux 后台 Bash 任务。最多同时运行 3 个任务。',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: '后台执行的 Bash 命令'
                    },
                    cwd: {
                        type: 'string',
                        description: '可选工作目录'
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

        registerTool({
            name: 'termux_jobs',
            displayName: 'List Termux Jobs',
            description: '列出所有后台任务及其日志。',
            parameters: {
                type: 'object',
                properties: {}
            },
            action: listJobs,
            formatMessage: () => '查询 Termux 后台任务',
            shouldRegister: () => true,
            stealth: false
        });

        registerTool({
            name: 'termux_job_status',
            displayName: 'Termux Job Status',
            description: '查看指定后台任务的状态和日志内容。',
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
            action: jobStatus,
            formatMessage: ({ job_id }) =>
                `查询任务：${job_id}`,
            shouldRegister: () => true,
            stealth: false
        });

        registerTool({
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
                `停止任务：${job_id}`,
            shouldRegister: () => true,
            stealth: false
        });

        registerTool({
            name: 'termux_stop_all_jobs',
            displayName: 'Stop All Termux Jobs',
            description: '终止全部正在运行的 Termux 后台任务。',
            parameters: {
                type: 'object',
                properties: {}
            },
            action: stopAllJobs,
            formatMessage: () => '终止全部后台任务',
            shouldRegister: () => true,
            stealth: false
        });

        registered = true;
        setStatus('LLM Shell 工具已注册');
        console.log('[Termux Shell Bridge] 工具注册成功');
        return true;
    }

    function setStatus(text) {
        const element = document.getElementById('tsb-status');

        if (element) {
            element.textContent = text;
        }
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

        const value = settings();
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
                    value="${value.url || 'http://127.0.0.1:8765'}">

                <label>Token</label>
                <input id="tsb-token" class="text_pole"
                    type="password" value="${value.token || ''}">

                <label>执行模式</label>
                <select id="tsb-mode" class="text_pole">
                    <option value="ask">每次命令确认</option>
                    <option value="trust">当前聊天自动执行</option>
                </select>

                <button id="tsb-test" class="menu_button">
                    测试连接
                </button>
                <button id="tsb-revoke" class="menu_button">
                    撤销当前聊天授权
                </button>
                <button id="tsb-stop-all" class="menu_button">
                    终止全部后台任务
                </button>

                <div id="tsb-status">正在初始化</div>
                <pre id="tsb-result"></pre>
            </div>
        `;

        target.appendChild(panel);

        const url = document.getElementById('tsb-url');
        const token = document.getElementById('tsb-token');
        const mode = document.getElementById('tsb-mode');
        const output = document.getElementById('tsb-result');

        mode.value = value.mode || 'ask';

        function save() {
            saveSettings(
                url.value.trim(),
                token.value.trim(),
                mode.value
            );
        }

        document.getElementById('tsb-test').onclick = async () => {
            save();

            try {
                output.textContent = stringify(
                    await request('/health')
                );
            } catch (error) {
                output.textContent =
                    `连接失败：${error.message}`;
            }
        };

        document.getElementById('tsb-revoke').onclick = () => {
            sessionStorage.removeItem(APPROVAL);
            setStatus('当前聊天授权已撤销');
        };

        document.getElementById('tsb-stop-all').onclick = async () => {
            if (!ask('终止全部后台任务')) return;

            try {
                output.textContent = stringify(
                    await request('/jobs/stop-all', {
                        method: 'POST',
                        body: '{}'
                    })
                );
            } catch (error) {
                output.textContent =
                    `操作失败：${error.message}`;
            }
        };

        return true;
    }

    function init() {
        refreshChat();
        createPanel();
        registerTools();
    }

    window.addEventListener('load', init);
    document.addEventListener('DOMContentLoaded', init);

    setInterval(() => {
        refreshChat();
        createPanel();
        registerTools();
    }, 1000);

    setTimeout(init, 1000);
    setTimeout(init, 3000);
})();
