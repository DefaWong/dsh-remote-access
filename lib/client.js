window.__ModuleLoader__.load({
  id: "dsh-remote-access",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Browser half: the plugin's settings page on its Plugins detail screen. It
 * edits the listener row's live configuration through the shared config form
 * and shows the address phones open, read from the Host status route.
 */
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const PACKAGE = 'dsh-remote-access';
const ROW = 'remote-access-listener';
const NS = 'remoteAccess';
const STATUS_ROUTE = 'remote-access/status';
const STATUS_POLL_MS = 3000;
const zh = {
    address: '访问地址',
    starting: '正在启动…',
    noToken: '设置访问令牌并保存后开始监听。',
    failed: '无法监听：',
    unreachable: '暂时读不到监听状态。',
    copy: '复制链接',
    copied: '已复制',
    linkHint: '在手机浏览器打开这个链接即可登录，之后直接访问不带令牌的地址。链接含令牌，请勿外传。',
    saveFirst: '修改尚未保存，保存后生效。',
    addresses: '本机可用地址：',
    host: '监听地址',
    hostHint: '留空时自动使用当前网卡的局域网 IPv4 地址，网络切换后会自动跟随。',
    auto: '自动',
    port: '端口',
    portHint: '默认 30990。',
    token: '访问令牌',
    tokenHint: '至少 16 个字符，登录远程地址时使用。',
    generate: '生成新令牌',
    overridden: '已修改',
    reset: '恢复默认',
    invalidNumber: '请输入 1 到 65535 之间的整数。',
    unavailable: '插件尚未加载，暂时无法配置。',
    readOnly: '此部署的设置为只读。',
    saveFailed: '保存未被接受：令牌至少 16 个字符且不含空格，监听地址须为 IP 地址。',
    save: '保存',
    saving: '正在保存…',
};
const en = {
    address: 'Address',
    starting: 'Starting…',
    noToken: 'Set and save an access token to start listening.',
    failed: 'Cannot listen: ',
    unreachable: 'The listener status is not available right now.',
    copy: 'Copy link',
    copied: 'Copied',
    linkHint: 'Open this link in the phone\'s browser to sign in; afterwards the address without the token is enough. The link contains the token; keep it private.',
    saveFirst: 'Unsaved changes take effect after saving.',
    addresses: 'Addresses on this computer: ',
    host: 'Listen address',
    hostHint: 'Leave blank to use the LAN IPv4 address of the active network adapter; it follows network changes.',
    auto: 'Automatic',
    port: 'Port',
    portHint: 'Default 30990.',
    token: 'Access token',
    tokenHint: 'At least 16 characters, used to sign in at the remote address.',
    generate: 'Generate token',
    overridden: 'Changed',
    reset: 'Reset to default',
    invalidNumber: 'Enter a whole number from 1 to 65535.',
    unavailable: 'The plugin is not loaded, so it cannot be configured right now.',
    readOnly: 'This deployment stores settings read-only.',
    saveFailed: 'The values were not accepted: the token needs at least 16 characters without spaces, and the listen address must be an IP address.',
    save: 'Save',
    saving: 'Saving…',
};
function generateToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function readStatus(signal) {
    try {
        const response = await fetch(STATUS_ROUTE, { cache: 'no-store', signal });
        if (!response.ok)
            return { status: { state: 'unreachable' }, addresses: [] };
        const body = await response.json();
        const { addresses, ...status } = body;
        return { status, addresses: addresses ?? [] };
    }
    catch (_error) {
        // An aborted poll or a Host that is restarting; the next poll answers.
        return { status: { state: 'unreachable' }, addresses: [] };
    }
}
function useStatus() {
    const [answer, setAnswer] = (0, react_1.useState)();
    (0, react_1.useEffect)(() => {
        const controller = new AbortController();
        const poll = () => { void readStatus(controller.signal).then((next) => { if (!controller.signal.aborted)
            setAnswer(next); }); };
        poll();
        const timer = setInterval(poll, STATUS_POLL_MS);
        return () => { controller.abort(); clearInterval(timer); };
    }, []);
    return answer;
}
const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 };
function AddressBlock(props) {
    const { t, answer } = props;
    const [copied, setCopied] = (0, react_1.useState)(false);
    const status = answer?.status ?? { state: 'starting' };
    let body;
    if (status.state === 'listening') {
        const link = `${status.url}?token=${encodeURIComponent(props.savedToken)}`;
        body = ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [(0, jsx_runtime_1.jsx)("code", { style: { fontSize: 13, wordBreak: 'break-all', userSelect: 'all' }, children: link }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { size: "sm", variant: "outline", onClick: () => {
                                void navigator.clipboard.writeText(link).then(() => {
                                    setCopied(true);
                                    setTimeout(() => { setCopied(false); }, 1500);
                                });
                            }, children: copied ? t('copied') : t('copy') })] }), (0, jsx_runtime_1.jsx)("p", { style: muted, children: t('linkHint') })] }));
    }
    else if (status.state === 'no-token') {
        body = (0, jsx_runtime_1.jsx)("p", { style: muted, children: t('noToken') });
    }
    else if (status.state === 'failed') {
        body = (0, jsx_runtime_1.jsxs)("p", { style: { ...muted, color: 'var(--dsw-alias-label-danger, #d33)' }, children: [t('failed'), status.error] });
    }
    else {
        body = (0, jsx_runtime_1.jsx)("p", { style: muted, children: t(status.state === 'unreachable' ? 'unreachable' : 'starting') });
    }
    const addresses = answer?.addresses ?? [];
    return ((0, jsx_runtime_1.jsxs)("div", { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }, children: [(0, jsx_runtime_1.jsx)("strong", { style: { fontSize: 14 }, children: t('address') }), body, props.dirty && (0, jsx_runtime_1.jsx)("p", { style: muted, children: t('saveFirst') }), status.state === 'failed' && addresses.length > 0 && ((0, jsx_runtime_1.jsxs)("p", { style: muted, children: [t('addresses'), addresses.map(entry => `${entry.address} (${entry.name})`).join('、')] }))] }));
}
function RemoteAccessPage(props) {
    const { t, actions } = props;
    const state = (0, react_1.useSyncExternalStore)(props.store.subscribe, props.store.getSnapshot);
    const answer = useStatus();
    const disabled = !state.shell.writable || state.shell.saving;
    const common = { overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'), disabled };
    const detected = answer?.status.state === 'listening' && answer.status.auto ? answer.status.host : undefined;
    return ((0, jsx_runtime_1.jsxs)(dsh_client_ui_primitives_1.SettingsForm, { labels: { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }, state: state.shell, onSave: actions.save, onDiscard: actions.discard, children: [(0, jsx_runtime_1.jsx)(AddressBlock, { t: t, answer: answer, savedToken: state.savedToken, dirty: state.shell.dirty }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.SettingsValueField, { id: "remote-access-host", label: t('host'), hint: t('hostHint'), placeholder: detected === undefined ? t('auto') : `${t('auto')}（${detected}）`, ...common, ...state.host, onEdit: (text) => { actions.edit('host', text); }, onReset: () => { actions.resetField('host'); } }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.SettingsValueField, { id: "remote-access-port", label: t('port'), hint: t('portHint'), numeric: true, ...common, ...state.port, onEdit: (text) => { actions.edit('port', text); }, onReset: () => { actions.resetField('port'); } }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.SettingsValueField, { id: "remote-access-token", label: t('token'), hint: t('tokenHint'), ...common, ...state.token, onEdit: (text) => { actions.edit('token', text); }, onReset: () => { actions.resetField('token'); } }), (0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { size: "sm", variant: "outline", disabled: disabled, onClick: () => { actions.edit('token', generateToken()); }, children: t('generate') }) })] }));
}
/** Client services this page waits for. */
exports.inject = ['slots', 'locale', 'configForms'];
/**
 * Register the settings page on this plugin's detail screen.
 * @param ctx - client plugin context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'remote-access: dictionaries');
    const scope = ctx.configForms.get(ROW);
    const model = new dsh_client_ui_primitives_1.SettingsFormModel(scope, [(0, dsh_client_ui_primitives_1.settingsTextField)('host'), (0, dsh_client_ui_primitives_1.settingsNumberField)('port'), (0, dsh_client_ui_primitives_1.settingsTextField)('token')]);
    ctx.effect(() => () => { model.dispose(); }, 'remote-access: form');
    const store = model.bind(() => {
        const value = scope.getSnapshot().value;
        return {
            shell: model.shell(),
            host: model.field('host'),
            port: model.field('port'),
            token: model.field('token'),
            savedToken: typeof value?.token === 'string' ? value.token : '',
        };
    });
    const actions = model.actions();
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, locale: NS }, ({ t }) => (0, jsx_runtime_1.jsx)(RemoteAccessPage, { t: t, store: store, actions: actions })));
}

    return module.exports;
  }
});
