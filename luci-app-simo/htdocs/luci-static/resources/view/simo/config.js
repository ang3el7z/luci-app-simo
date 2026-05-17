'use strict';
'require view';
'require fs';
'require ui';
'require rpc';
'require network';

const CONFIG_PATH = '/opt/simo/config.yaml';
const CONFIG_DIR = '/opt/simo';
const MAIN_CONFIG_NAME = 'config.yaml';
const CONFIG_PROFILES = [
	{ name: 'config.yaml', label: 'Main Config #1' },
	{ name: 'config2.yaml', label: 'Backup Config #2' },
	{ name: 'config3.yaml', label: 'Backup Config #3' }
];
const SETTINGS_PATH = '/opt/simo/settings';
const RULESET_PATH = '/opt/simo/lst/';
const FAKEIP_WHITELIST_FILENAME = 'fakeip-whitelist-ipcidr.txt';
const ACE_BASE = '/luci-static/resources/view/simo/ace/';
const TMP_SUBSCRIPTION_PATH = '/tmp/simo-subscription.yaml';
const UI_THEME_KEY = 'UI_THEME';
const MIHOMO_RELEASE_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const SINGBOX_RELEASE_API = 'https://api.github.com/repos/SagerNet/sing-box/releases/latest';
const SIMO_RELEASE_API = 'https://api.github.com/repos/ang3el7z/luci-app-simo/releases/latest';
const KERNEL_MANAGER_BIN = '/opt/simo/bin/simo-kernel-manager';
const SIMO_RUNTIME_BIN = '/opt/simo/bin/simo-runtime';
const SINGBOX_CONFIG_PATH = '/opt/simo/config-singbox.json';
const UPDATE_CHECK_MS = 10 * 60 * 1000;
const SUBSCRIPTION_CURL_CONNECT_TIMEOUT_SEC = 8;
const SUBSCRIPTION_CURL_MAX_TIME_SEC = 18;

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

const LOG_POLL_MS = 5000;
const STATUS_POLL_MS = 5000;
const KERNEL_TYPES = ['mihomo', 'sing-box'];
const KERNEL_ADAPTERS = {
	mihomo: {
		id: 'mihomo',
		displayName: 'mihomo',
		binaryPath: '/opt/simo/bin/mihomo',
		releaseApi: MIHOMO_RELEASE_API,
		versionArgs: [['-v'], ['version']],
		findAsset: function(release, arch) {
			return findMihomoKernelAsset(release, arch);
		},
		installFromAsset: async function(asset, releaseVersion, arch) {
			return downloadMihomoKernel(asset.browser_download_url, releaseVersion, arch);
		}
	},
	'sing-box': {
		id: 'sing-box',
		displayName: 'sing-box',
		binaryPath: '/opt/simo/bin/sing-box',
		releaseApi: SINGBOX_RELEASE_API,
		versionArgs: [['version'], ['-V']],
		findAsset: function(release, arch) {
			return findSingboxKernelAsset(release, arch);
		},
		installFromAsset: async function(asset, releaseVersion, arch) {
			return downloadSingboxKernel(asset.browser_download_url, releaseVersion, arch, asset.name);
		}
	}
};

let editor = null;
let pageRoot = null;
let controlPollTimer = null;
let logPollTimer = null;
let updatePollTimer = null;
let rulesetMainEditor = null;
let rulesetWhitelistEditor = null;
let firstRunKernelPromptShown = false;
let curlBinaryCache = null;

function createEmptyKernelStatus() {
	const cores = {};
	for (let i = 0; i < KERNEL_TYPES.length; i++) {
		cores[KERNEL_TYPES[i]] = { installed: false, version: null };
	}

	return {
		activeCore: 'mihomo',
		selectedCore: 'mihomo',
		cores: cores,
		installed: false,
		version: null
	};
}

const appState = {
	versions: { app: 'unknown', core: 'unknown' },
	kernelStatus: createEmptyKernelStatus(),
	serviceRunning: false,
	proxyMode: 'tproxy',
	configContent: '',
	subscriptionUrl: '',
	selectedConfigName: MAIN_CONFIG_NAME,
	configProfiles: CONFIG_PROFILES.slice(),
	settings: null,
	interfaces: [],
	selectedInterfaces: [],
	detectedLan: '',
	detectedWan: '',
	activeCtrlTab: 'control',
	activeCfgTab: 'config',
	logsRaw: '',
	logsUpdatedAt: 0,
	uiTheme: 'dark',
	releaseMeta: {
		appVersion: '',
		kernelVersion: '',
		kernelVersions: {
			mihomo: '',
			'sing-box': ''
		},
		checkedAt: 0
	}
};

function notify(type, message) {
	const node = ui.addNotification(null, E('p', String(message || '')), type);
	const timeout = type === 'error' ? 10000 : 6000;
	if (node) {
		setTimeout(() => {
			try {
				node.remove();
			} catch (e) {}
		}, timeout);
	}
}

function safeText(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function isValidUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch (e) {
		return false;
	}
}

function normalizeConfigProfileName(name) {
	const clean = String(name || '').trim();
	return CONFIG_PROFILES.some((item) => item.name === clean) ? clean : MAIN_CONFIG_NAME;
}

function getConfigProfileByName(name) {
	const normalized = normalizeConfigProfileName(name);
	return CONFIG_PROFILES.find((item) => item.name === normalized) || CONFIG_PROFILES[0];
}

function getConfigLabel(name) {
	return getConfigProfileByName(name).label;
}

function getConfigPathByName(name) {
	return CONFIG_DIR + '/' + normalizeConfigProfileName(name);
}

function getSubscriptionKeyForConfig(name) {
	const normalized = normalizeConfigProfileName(name).replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
	return 'SUBSCRIPTION_URL_' + normalized;
}

async function setFileMode(path) {
	await L.resolveDefault(fs.exec('/bin/chmod', ['0644', path]), null);
	await L.resolveDefault(fs.exec('/usr/bin/chmod', ['0644', path]), null);
}

async function readConfigFileByName(name) {
	const path = getConfigPathByName(name);
	await setFileMode(path);
	return String(await L.resolveDefault(fs.read(path), ''));
}

async function writeConfigFileByName(name, content) {
	const path = getConfigPathByName(name);
	const normalized = String(content || '').trimEnd() + '\n';
	await fs.write(path, normalized);
	await setFileMode(path);
}

async function ensureConfigProfilesReady(seedMainContent) {
	const mainPath = getConfigPathByName(MAIN_CONFIG_NAME);
	let mainContent = await L.resolveDefault(fs.read(mainPath), null);
	if (mainContent == null) {
		mainContent = String(seedMainContent || '');
		await fs.write(mainPath, String(mainContent).trimEnd() + '\n');
	}
	await setFileMode(mainPath);

	for (let i = 0; i < CONFIG_PROFILES.length; i++) {
		const profile = CONFIG_PROFILES[i];
		const path = getConfigPathByName(profile.name);
		const existing = await L.resolveDefault(fs.read(path), null);
		if (existing == null) {
			await fs.write(path, String(mainContent || '').trimEnd() + '\n');
		}
		await setFileMode(path);
	}
}

function parseSettingsToMap(raw) {
	const map = {};
	String(raw || '').split('\n').forEach((line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.charAt(0) === '#') return;
		const idx = trimmed.indexOf('=');
		if (idx <= 0) return;
		const key = trimmed.slice(0, idx).trim();
		const value = trimmed.slice(idx + 1).trim();
		if (key) map[key] = value;
	});
	return map;
}

function mapToSettingsContent(map) {
	return Object.keys(map).map((k) => k + '=' + map[k]).join('\n') + '\n';
}

async function readSettingsMap() {
	try {
		return parseSettingsToMap(await fs.read(SETTINGS_PATH));
	} catch (e) {
		return {};
	}
}

async function writeSettingsMap(map) {
	await fs.write(SETTINGS_PATH, mapToSettingsContent(map));
}

function normalizeTheme(theme) {
	return theme === 'light' ? 'light' : 'dark';
}

function getPreferredAceTheme() {
	return appState.uiTheme === 'light' ? 'ace/theme/textmate' : 'ace/theme/tomorrow_night_bright';
}

function applyThemeToEditor(editorInstance) {
	if (!editorInstance) return;
	try {
		editorInstance.setTheme(getPreferredAceTheme());
	} catch (e) {
		editorInstance.setTheme('ace/theme/tomorrow_night_bright');
	}
}

async function readThemePreference() {
	const settings = await readSettingsMap();
	const saved = String(settings[UI_THEME_KEY] || '').trim();
	return saved ? normalizeTheme(saved) : '';
}

async function saveThemePreference(theme) {
	const settings = await readSettingsMap();
	settings[UI_THEME_KEY] = normalizeTheme(theme);
	await writeSettingsMap(settings);
}

function applyEditorTheme() {
	applyThemeToEditor(editor);
	applyThemeToEditor(rulesetMainEditor);
	applyThemeToEditor(rulesetWhitelistEditor);
}

function detectInitialTheme() {
	const root = document.documentElement;
	const body = document.body;
	const signal = [
		root ? root.className : '',
		body ? body.className : '',
		root ? root.getAttribute('data-theme') : '',
		root ? root.getAttribute('theme') : '',
		body ? body.getAttribute('data-theme') : '',
		body ? body.getAttribute('theme') : ''
	].join(' ').toLowerCase();

	if (/(^|\s)(dark|night)(\s|$)/.test(signal)) return 'dark';
	if (/(^|\s)(light|bright)(\s|$)/.test(signal)) return 'light';
	if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
	return 'light';
}

function applyUiTheme(theme) {
	appState.uiTheme = normalizeTheme(theme);

	if (pageRoot) {
		pageRoot.classList.toggle('sbox-theme-dark', appState.uiTheme === 'dark');
		pageRoot.classList.toggle('sbox-theme-light', appState.uiTheme === 'light');

		const btn = pageRoot.querySelector('#sbox-theme-toggle');
		if (btn) {
			btn.textContent = appState.uiTheme === 'dark' ? '\u2600' : '\u263D';
			btn.title = appState.uiTheme === 'dark'
				? _('Switch to light theme')
				: _('Switch to dark theme');
		}
	}

	applyEditorTheme();
}

async function readSubscriptionUrl(configName) {
	const normalized = normalizeConfigProfileName(configName || MAIN_CONFIG_NAME);
	const key = getSubscriptionKeyForConfig(normalized);
	const settings = await readSettingsMap();

	if (normalized === MAIN_CONFIG_NAME) {
		return String(settings[key] || settings.SUBSCRIPTION_URL || '').trim();
	}

	return String(settings[key] || '').trim();
}

async function saveSubscriptionUrl(url, configName) {
	const normalized = normalizeConfigProfileName(configName || MAIN_CONFIG_NAME);
	const key = getSubscriptionKeyForConfig(normalized);
	const clean = String(url || '').trim().replace(/\r?\n/g, '');
	const settings = await readSettingsMap();
	settings[key] = clean;
	if (normalized === MAIN_CONFIG_NAME) {
		settings.SUBSCRIPTION_URL = clean;
	}
	await writeSettingsMap(settings);
}

function parseVersion(raw, fallback) {
	const str = String(raw || '').trim();
	if (!str) return fallback;
	const matched = str.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
	return matched ? matched[1] : str.split('\n')[0];
}

function parsePackageVersion(raw, packageName) {
	const text = String(raw || '').trim();
	if (!text) return '';

	const escaped = String(packageName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const patterns = [
		new RegExp('^\\s*Version\\s*:\\s*([^\\s]+)', 'im'),
		new RegExp(escaped + '\\s*-\\s*([^\\s]+)', 'i'),
		new RegExp(escaped + '-([\\w.+~:-]+)', 'i'),
		new RegExp('(\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?)', 'i')
	];

	for (let i = 0; i < patterns.length; i++) {
		const match = text.match(patterns[i]);
		if (match && match[1]) return match[1].trim();
	}

	return '';
}

function parseVersionFromOpkgStatus(raw, packageNames) {
	const text = String(raw || '');
	if (!text) return '';

	for (let i = 0; i < packageNames.length; i++) {
		const escaped = String(packageNames[i] || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp(
			'(^|\\n)\\s*Package\\s*:\\s*' + escaped + '\\s*[\\s\\S]*?\\n\\s*Version\\s*:\\s*([^\\s\\n]+)',
			'i'
		);
		const match = text.match(pattern);
		if (match && match[2]) return match[2].trim();
	}

	return '';
}

function normalizeAppVersion(version) {
	const str = String(version || '').trim();
	if (!str) return '';
	const numeric = str.match(/^\d+(?:\.\d+)+/);
	if (numeric && numeric[0]) return numeric[0];
	return str.replace(/-r\d+$/i, '').replace(/-\d+$/, '');
}

async function getVersions() {
	const info = { app: 'unknown', core: 'unknown' };
	const packageName = 'luci-app-simo';

	try {
		const coreV = await fs.exec('/opt/simo/bin/core', ['-v']);
		const coreVersion = String(coreV.stdout || coreV.stderr || '');
		if (coreVersion) {
			info.core = parseVersion(coreVersion, 'installed');
		} else {
			const alt = await fs.exec('/opt/simo/bin/core', ['version']);
			info.core = parseVersion(alt.stdout || alt.stderr, 'installed');
		}
	} catch (e) {}

	try {
		const result = await fs.exec('/bin/opkg', ['list-installed', packageName]);
		const raw = String(result.stdout || '') + '\n' + String(result.stderr || '');
		const parsed = parsePackageVersion(raw, packageName);
		if (parsed) info.app = normalizeAppVersion(parsed);
	} catch (_) {
		try {
			const result = await fs.exec('/usr/bin/apk', ['info', '-v', packageName]);
			const raw = String(result.stdout || '') + '\n' + String(result.stderr || '');
			const parsed = parsePackageVersion(raw, packageName);
			if (parsed) info.app = normalizeAppVersion(parsed);
		} catch (_) {}
	}

	if (info.app === 'unknown') {
		try {
			const opkgStatusRaw = await fs.read('/usr/lib/opkg/status');
			const parsed = parseVersionFromOpkgStatus(opkgStatusRaw, [packageName]);
			if (parsed) info.app = normalizeAppVersion(parsed);
		} catch (_) {}
	}

	return info;
}
function normalizeVersion(str) {
	if (!str) return '';
	const match = String(str).match(/v?(\d+\.\d+\.\d+)/i);
	return match ? match[1] : String(str).trim();
}

async function detectSystemArchitecture() {
	try {
		const releaseInfo = await L.resolveDefault(fs.read('/etc/openwrt_release'), null);
		const match = String(releaseInfo || '').match(/^DISTRIB_ARCH=['"]?([^'"\n]+)['"]?/m);
		const distribArch = match ? match[1] : '';

		if (!distribArch) return 'amd64';
		if (distribArch.startsWith('aarch64_')) return 'arm64';
		if (distribArch === 'x86_64') return 'amd64';
		if (distribArch.startsWith('i386_')) return '386';
		if (distribArch.startsWith('riscv64_')) return 'riscv64';
		if (distribArch.startsWith('loongarch64_')) return 'loong64';
		if (distribArch.includes('_neon-vfp')) return 'armv7';
		if (distribArch.includes('_neon') || distribArch.includes('_vfp')) return 'armv6';
		if (distribArch.startsWith('arm_')) return 'armv5';
		if (distribArch.startsWith('mips64el_')) return 'mips64le';
		if (distribArch.startsWith('mips64_')) return 'mips64';
		if (distribArch.startsWith('mipsel_')) return distribArch.includes('hardfloat') ? 'mipsle-hardfloat' : 'mipsle-softfloat';
		if (distribArch.startsWith('mips_')) return distribArch.includes('hardfloat') ? 'mips-hardfloat' : 'mips-softfloat';
	} catch (e) {}

	return 'amd64';
}

function normalizeKernelType(kernel) {
	const normalized = String(kernel || '').trim().toLowerCase();
	if (normalized === 'mihomo' || normalized === 'clash' || normalized === 'metacubex') return 'mihomo';
	if (normalized === 'sing-box' || normalized === 'singbox') return 'sing-box';
	return 'mihomo';
}

function getKernelAdapter(kernel) {
	const normalized = normalizeKernelType(kernel);
	return KERNEL_ADAPTERS[normalized] || KERNEL_ADAPTERS.mihomo;
}

function getCoreDisplayName(kernel) {
	return getKernelAdapter(kernel).displayName;
}

function getCoreBinaryPath(kernel) {
	return getKernelAdapter(kernel).binaryPath;
}

function getActiveCoreType() {
	if (!appState.kernelStatus) return 'mihomo';
	return normalizeKernelType(appState.kernelStatus.activeCore || appState.kernelStatus.selectedCore || 'mihomo');
}

function getCoreRuntimeStatus(kernel) {
	const normalized = normalizeKernelType(kernel);
	if (!appState.kernelStatus || !appState.kernelStatus.cores) return { installed: false, version: null };
	const state = appState.kernelStatus.cores[normalized];
	return state ? state : { installed: false, version: null };
}

async function getCoreBinaryStatus(kernel) {
	const adapter = getKernelAdapter(kernel);
	const binPath = adapter.binaryPath;

	try {
		const stat = await L.resolveDefault(fs.stat(binPath), null);
		if (!stat) return { installed: false, version: null };
	} catch (e) {
		return { installed: false, version: null };
	}

	const argsList = adapter.versionArgs || [['-v'], ['version']];

	for (let i = 0; i < argsList.length; i++) {
		try {
			const result = await fs.exec(binPath, argsList[i]);
			const output = String(result.stdout || result.stderr || '').trim();
			if (output) return { installed: true, version: parseVersion(output, _('Installed')) };
		} catch (e) {}
	}

	return { installed: true, version: _('Installed') };
}

function parseKernelManagerStatus(raw) {
	const parsed = {};
	String(raw || '').split('\n').forEach((line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		const idx = trimmed.indexOf('=');
		if (idx <= 0) return;
		const key = trimmed.slice(0, idx).trim();
		const value = trimmed.slice(idx + 1).trim();
		if (key) parsed[key] = value;
	});

	return {
		active: normalizeKernelType(parsed.active || parsed.selected || 'mihomo'),
		selected: normalizeKernelType(parsed.selected || parsed.active || 'mihomo')
	};
}

async function getKernelManagerStatus() {
	try {
		const result = await fs.exec(KERNEL_MANAGER_BIN, ['status']);
		if (result.code === 0) {
			const raw = String(result.stdout || '') + '\n' + String(result.stderr || '');
			return parseKernelManagerStatus(raw);
		}
	} catch (e) {}

	try {
		const result = await fs.exec(KERNEL_MANAGER_BIN, ['get-active']);
		const core = normalizeKernelType(String(result.stdout || result.stderr || '').trim());
		return { active: core, selected: core };
	} catch (e) {}

	return { active: 'mihomo', selected: 'mihomo' };
}

function composeKernelStatus(manager, coreStatuses) {
	const active = normalizeKernelType(manager.active || manager.selected || 'mihomo');
	const selected = normalizeKernelType(manager.selected || active);
	const cores = {};
	for (let i = 0; i < KERNEL_TYPES.length; i++) {
		const coreType = KERNEL_TYPES[i];
		cores[coreType] = coreStatuses[coreType] || { installed: false, version: null };
	}

	return {
		activeCore: active,
		selectedCore: selected,
		cores: cores,
		installed: !!(cores[active] && cores[active].installed),
		version: cores[active] ? cores[active].version : null
	};
}

async function getKernelStatus() {
	const [manager, statusList] = await Promise.all([
		getKernelManagerStatus(),
		Promise.all(KERNEL_TYPES.map((coreType) => getCoreBinaryStatus(coreType)))
	]);
	const coreStatuses = {};
	for (let i = 0; i < KERNEL_TYPES.length; i++) {
		coreStatuses[KERNEL_TYPES[i]] = statusList[i];
	}
	return composeKernelStatus(manager, coreStatuses);
}

async function syncActiveCoreLink(kernel) {
	const args = ['sync'];
	if (kernel) args.push(normalizeKernelType(kernel));
	await L.resolveDefault(fs.exec(KERNEL_MANAGER_BIN, args), null);
}

async function setActiveKernel(kernel) {
	const normalized = normalizeKernelType(kernel);
	const result = await fs.exec(KERNEL_MANAGER_BIN, ['set-active', normalized]);
	if (result.code !== 0) {
		throw new Error(String(result.stderr || result.stdout || _('Failed to set active kernel')).trim());
	}
}

async function execRuntimeOrThrow(args, fallbackMessage) {
	const result = await fs.exec(SIMO_RUNTIME_BIN, args || []);
	if (result && typeof result.code === 'number' && result.code !== 0) {
		throw new Error(String(result.stderr || result.stdout || fallbackMessage || _('Runtime command failed')).trim());
	}
	return result;
}

async function prepareCoreRuntime(coreType) {
	const core = normalizeKernelType(coreType);
	return execRuntimeOrThrow(['prepare', core], _('Failed to prepare runtime config.'));
}

async function migrateCoreRuntime(coreType) {
	return prepareCoreRuntime(coreType);
}

async function validateCoreRuntime(coreType) {
	const core = normalizeKernelType(coreType);
	return execRuntimeOrThrow(['validate', core], _('Failed to validate runtime config.'));
}

function sleepMs(ms) {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function detectCurlBinary() {
	if (curlBinaryCache) return curlBinaryCache;
	const candidates = ['/usr/bin/curl', '/bin/curl'];

	for (let i = 0; i < candidates.length; i++) {
		try {
			const probe = await fs.exec(candidates[i], ['--version']);
			if (probe && typeof probe.code === 'number') {
				curlBinaryCache = candidates[i];
				return curlBinaryCache;
			}
		} catch (e) {}
	}

	return null;
}

async function getMihomoHealthProbe() {
	const configRaw = await L.resolveDefault(fs.read(CONFIG_PATH), '');
	if (!configRaw) return null;

	const externalController = parseYamlValue(configRaw, 'external-controller');
	const externalControllerTls = parseYamlValue(configRaw, 'external-controller-tls');
	const secret = parseYamlValue(configRaw, 'secret') || '';
	const useTls = !!externalControllerTls;
	const listenAddr = externalControllerTls || externalController;

	if (!listenAddr) return null;

	const hostPort = normalizeHostPortFromAddr(listenAddr, '127.0.0.1', '9090');
	const scheme = useTls ? 'https' : 'http';
	return {
		url: scheme + '://127.0.0.1:' + hostPort.port + '/version',
		secret: secret,
		insecureTls: useTls
	};
}

async function getSingboxHealthProbe() {
	try {
		const configRaw = await L.resolveDefault(fs.read(SINGBOX_CONFIG_PATH), '');
		if (!configRaw) return null;
		const parsed = JSON.parse(configRaw);
		const clashApi = parsed && parsed.experimental && parsed.experimental.clash_api;
		if (!clashApi || !clashApi.external_controller) return null;

		const hostPort = normalizeHostPortFromAddr(clashApi.external_controller, '127.0.0.1', '9090');
		return {
			url: 'http://127.0.0.1:' + hostPort.port + '/version',
			secret: String(clashApi.secret || ''),
			insecureTls: false
		};
	} catch (e) {
		return null;
	}
}

async function getRuntimeHealthProbe(coreType) {
	const core = normalizeKernelType(coreType || getActiveCoreType());
	return core === 'sing-box'
		? getSingboxHealthProbe()
		: getMihomoHealthProbe();
}

async function probeRuntimeApiHealth(coreType) {
	const probe = await getRuntimeHealthProbe(coreType);
	if (!probe || !probe.url) return null;

	const curlBin = await detectCurlBinary();
	if (!curlBin) return null;

	const args = ['-fsS', '--max-time', '2'];
	if (probe.insecureTls) args.push('-k');
	if (probe.secret) args.push('-H', 'Authorization: Bearer ' + probe.secret);
	args.push(probe.url);

	try {
		const res = await fs.exec(curlBin, args);
		return !!(res && res.code === 0);
	} catch (e) {
		return false;
	}
}

async function waitForRuntimeHealthy(coreType, timeoutMs, intervalMs) {
	const core = normalizeKernelType(coreType || getActiveCoreType());
	const timeout = Number(timeoutMs || 15000);
	const interval = Number(intervalMs || 1000);
	const start = Date.now();

	while (Date.now() - start < timeout) {
		const running = await getServiceStatus();
		if (running) {
			const apiState = await probeRuntimeApiHealth(core);
			if (apiState === true || apiState === null) return true;
		}
		await sleepMs(interval);
	}

	if (!(await getServiceStatus())) return false;
	const finalApiState = await probeRuntimeApiHealth(core);
	return finalApiState === true || finalApiState === null;
}

async function fetchLatestReleaseFromApi(apiUrl, allowPrerelease) {
	try {
		const response = await fetch(apiUrl);
		if (!response.ok) return null;
		const data = await response.json();
		if (!data || !data.tag_name || !Array.isArray(data.assets)) return null;
		if (!allowPrerelease && data.prerelease) return null;
		return { version: data.tag_name, assets: data.assets };
	} catch (e) {
		return null;
	}
}

async function getLatestKernelRelease(coreType) {
	const adapter = getKernelAdapter(coreType);
	return fetchLatestReleaseFromApi(adapter.releaseApi, false);
}

async function getLatestSimoRelease() {
	return fetchLatestReleaseFromApi(SIMO_RELEASE_API, true);
}

function compareNumericVersions(left, right) {
	const normalize = (value) => {
		const matched = String(value || '').trim().match(/\d+(?:\.\d+)+/);
		if (!matched || !matched[0]) return null;
		return matched[0].split('.').map((item) => parseInt(item, 10));
	};

	const l = normalize(left);
	const r = normalize(right);
	if (!l || !r) return null;

	const len = Math.max(l.length, r.length);
	for (let i = 0; i < len; i++) {
		const a = i < l.length ? l[i] : 0;
		const b = i < r.length ? r[i] : 0;
		if (a < b) return -1;
		if (a > b) return 1;
	}

	return 0;
}

function resolveAppActionState() {
	const local = normalizeAppVersion(appState.versions?.app || '');
	const latest = normalizeAppVersion(appState.releaseMeta?.appVersion || '');
	const hasLocal = !!local && local !== 'unknown';
	const cmp = compareNumericVersions(local, latest);
	const hasUpdate = !!latest && (!hasLocal || cmp === -1 || (cmp === null && local !== latest));

	if (!hasLocal) {
		return {
			kind: 'install',
			icon: '\u2b07',
			className: 'sbox-version-action-install',
			title: _('Install Simo')
		};
	}

	if (hasUpdate) {
		return {
			kind: 'update',
			icon: '\u2b07',
			className: 'sbox-version-action-install',
			title: _('Update Simo')
		};
	}

	return {
		kind: 'reinstall',
		icon: '\u21bb',
		className: 'sbox-version-action-reinstall',
		title: _('Reinstall Simo')
	};
}

function resolveKernelActionState() {
	const activeCore = getActiveCoreType();
	const coreLabel = getCoreDisplayName(activeCore);
	const coreStatus = getCoreRuntimeStatus(activeCore);
	const installed = !!coreStatus.installed;
	const local = normalizeVersion(
		coreStatus.version ||
		appState.versions?.core ||
		''
	);
	const latest = normalizeVersion(
		(appState.releaseMeta && appState.releaseMeta.kernelVersions && appState.releaseMeta.kernelVersions[activeCore]) ||
		appState.releaseMeta?.kernelVersion ||
		''
	);
	const cmp = compareNumericVersions(local, latest);
	const hasUpdate = installed && !!latest && (!local || cmp === -1 || (cmp === null && local !== latest));

	if (!installed) {
		return {
			kind: 'install',
			icon: '\u2b07',
			className: 'sbox-version-action-install',
			title: _('Install %s kernel').format(coreLabel)
		};
	}

	if (hasUpdate) {
		return {
			kind: 'update',
			icon: '\u2b07',
			className: 'sbox-version-action-install',
			title: _('Update %s kernel').format(coreLabel)
		};
	}

	return {
		kind: 'reinstall',
		icon: '\u21bb',
		className: 'sbox-version-action-reinstall',
		title: _('Reinstall %s kernel').format(coreLabel)
	};
}

function shouldCheckAppRelease(force) {
	return true;
}

function shouldCheckKernelRelease(force) {
	return true;
}

async function refreshReleaseMeta(options) {
	const opts = options || {};
	const force = !!opts.force;
	const checkApp = shouldCheckAppRelease(force);
	const checkKernel = shouldCheckKernelRelease(force);

	if (!checkApp && !checkKernel) return false;

	const appReleasePromise = checkApp ? getLatestSimoRelease() : Promise.resolve(null);
	const kernelReleasePromises = checkKernel
		? KERNEL_TYPES.map((coreType) => getLatestKernelRelease(coreType))
		: [];
	const [appRelease, kernelReleases] = await Promise.all([
		appReleasePromise,
		checkKernel ? Promise.all(kernelReleasePromises) : Promise.resolve([])
	]);

	if (checkApp) {
		appState.releaseMeta.appVersion = appRelease ? normalizeAppVersion(appRelease.version || '') : '';
	}
	if (checkKernel) {
		const versions = {};
		for (let i = 0; i < KERNEL_TYPES.length; i++) {
			const coreType = KERNEL_TYPES[i];
			const release = kernelReleases[i];
			versions[coreType] = release ? normalizeVersion(release.version || '') : '';
		}
		appState.releaseMeta.kernelVersions = versions;
		const activeCore = getActiveCoreType();
		appState.releaseMeta.kernelVersion = appState.releaseMeta.kernelVersions[activeCore] || '';
	}
	appState.releaseMeta.checkedAt = Date.now();
	updateHeaderAndControlDom();
	return true;
}

function findMihomoKernelAsset(release, arch) {
	if (!release || !Array.isArray(release.assets)) return null;

	const tag = String(release.version || '');
	const cleanTag = tag.replace(/^v/i, '');
	const exactNames = [
		'mihomo-linux-' + arch + '-' + tag + '.gz',
		'mihomo-linux-' + arch + '-' + cleanTag + '.gz'
	];

	for (let i = 0; i < exactNames.length; i++) {
		const asset = release.assets.find((item) => item.name === exactNames[i]);
		if (asset) return asset;
	}

	return release.assets.find((item) =>
		item.name && item.name.indexOf('mihomo-linux-' + arch + '-') === 0 && item.name.endsWith('.gz')) || null;
}

function getSingboxArchCandidates(arch) {
	switch (arch) {
	case 'amd64':
	case '386':
	case 'arm64':
	case 'armv7':
	case 'armv6':
	case 'armv5':
	case 'riscv64':
	case 'loong64':
		return [arch];
	case 'mipsle-hardfloat':
		return ['mipsle', 'mipsle-softfloat'];
	case 'mipsle-softfloat':
		return ['mipsle-softfloat', 'mipsle'];
	case 'mips-hardfloat':
		return ['mips', 'mips-softfloat'];
	case 'mips-softfloat':
		return ['mips-softfloat', 'mips'];
	case 'mips64le':
		return ['mips64le', 'mips64le-softfloat'];
	case 'mips64':
		return ['mips64', 'mips64-softfloat'];
	default:
		return [arch];
	}
}

function choosePreferredSingboxAsset(candidates, baseName) {
	if (!Array.isArray(candidates) || !candidates.length) return null;

	const exactMusl = candidates.find((item) => item.name === baseName + '-musl.tar.gz');
	if (exactMusl) return exactMusl;

	const exact = candidates.find((item) => item.name === baseName + '.tar.gz');
	if (exact) return exact;

	const softfloatMusl = candidates.find((item) => item.name === baseName + '-softfloat-musl.tar.gz');
	if (softfloatMusl) return softfloatMusl;

	const softfloat = candidates.find((item) => item.name === baseName + '-softfloat.tar.gz');
	if (softfloat) return softfloat;

	const glibc = candidates.find((item) => item.name === baseName + '-glibc.tar.gz');
	if (glibc) return glibc;

	return candidates[0];
}

function findSingboxKernelAsset(release, arch) {
	if (!release || !Array.isArray(release.assets)) return null;

	const cleanTag = String(release.version || '').replace(/^v/i, '');
	const candidates = getSingboxArchCandidates(arch);

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		const base = 'sing-box-' + cleanTag + '-linux-' + candidate;
		const matched = release.assets.filter((item) =>
			item &&
			item.name &&
			item.name.indexOf(base) === 0 &&
			item.name.endsWith('.tar.gz')
		);
		const preferred = choosePreferredSingboxAsset(matched, base);
		if (preferred) return preferred;
	}

	return null;
}

function findKernelAssetForCore(coreType, release, arch) {
	const adapter = getKernelAdapter(coreType);
	return adapter.findAsset ? adapter.findAsset(release, arch) : null;
}

function findSimoAsset(release, managerType) {
	if (!release || !Array.isArray(release.assets)) return null;

	const rawTag = String(release.version || '');
	const cleanTag = rawTag.replace(/^v/i, '');
	const normalized = normalizeAppVersion(cleanTag);
	const ext = managerType === 'apk' ? '.apk' : '.ipk';
	const expectedNames = managerType === 'apk'
		? [
			'luci-app-simo-' + cleanTag + '.apk',
			'luci-app-simo-' + normalized + '.apk'
		]
		: [
			'luci-app-simo_' + cleanTag + '_all.ipk',
			'luci-app-simo_' + normalized + '_all.ipk'
		];

	for (let i = 0; i < expectedNames.length; i++) {
		const asset = release.assets.find((item) => item.name === expectedNames[i]);
		if (asset) return asset;
	}

	return release.assets.find((item) =>
		item &&
		item.name &&
		item.name.indexOf('luci-app-simo') !== -1 &&
		item.name.endsWith(ext)
	) || null;
}

async function detectPackageManager() {
	const checks = [
		{ type: 'apk', bin: '/usr/bin/apk' },
		{ type: 'apk', bin: '/bin/apk' },
		{ type: 'opkg', bin: '/bin/opkg' },
		{ type: 'opkg', bin: '/usr/bin/opkg' }
	];

	for (let i = 0; i < checks.length; i++) {
		try {
			const probe = await fs.exec(checks[i].bin, ['--version']);
			if (probe && typeof probe.code === 'number') return checks[i];
		} catch (e) {}
	}

	return null;
}

async function execOrThrow(bin, args, fallbackMessage) {
	const result = await fs.exec(bin, args);
	if (result.code === 0) return result;
	throw new Error(String(result.stderr || result.stdout || fallbackMessage || _('Command failed')).trim());
}

function isRpcReconnectLikeError(message) {
	const text = String(message || '').toLowerCase();
	if (!text) return false;
	if (text.indexOf('xhr') !== -1 && text.indexOf('timeout') !== -1) return true;
	if (text.indexOf('request timed out') !== -1) return true;
	if (text.indexOf('networkerror') !== -1) return true;
	if (text.indexOf('failed to fetch') !== -1) return true;
	if (text.indexOf('connection') !== -1 && (text.indexOf('closed') !== -1 || text.indexOf('reset') !== -1 || text.indexOf('refused') !== -1)) return true;
	return false;
}

async function installSimoDependencies(manager) {
	await execOrThrow(manager.bin, ['update'], _('Failed to update package index.'));

	if (manager.type === 'apk') {
		await execOrThrow(
			manager.bin,
			['add', 'curl', 'kmod-nft-tproxy', 'kmod-tun'],
			_('Failed to install Simo dependencies.')
		);
		return;
	}

	const release = await getOpenWrtReleaseVersion();
	const majorMatch = String(release || '').match(/^(\d+)/);
	const major = majorMatch ? parseInt(majorMatch[1], 10) : 0;
	const tproxyPkg = major > 0 && major < 23 ? 'iptables-mod-tproxy' : 'kmod-nft-tproxy';

	await execOrThrow(
		manager.bin,
		['install', 'curl', tproxyPkg, 'kmod-tun'],
		_('Failed to install Simo dependencies.')
	);
}

async function installSimoFromSettings(actionKind) {
	const manager = await detectPackageManager();
	if (!manager) throw new Error(_('No supported package manager found (apk/opkg).'));

	const release = await getLatestSimoRelease();
	if (!release) throw new Error(_('Failed to load Simo release information: %s').format(_('Unavailable')));

	const asset = findSimoAsset(release, manager.type);
	if (!asset || !asset.browser_download_url) {
		throw new Error(_('Failed to load Simo release information: %s').format(_('Download failed')));
	}

	const tmpPath = manager.type === 'apk' ? '/tmp/simo-update.apk' : '/tmp/simo-update.ipk';
	const mode = String(actionKind || 'update');
	const forceReinstall = mode === 'reinstall';

	try {
		notify('info', _('Downloading Simo package...'));
		await installSimoDependencies(manager);
		await execOrThrow('/usr/bin/curl', ['-L', '-fsS', asset.browser_download_url, '-o', tmpPath], _('Download failed'));

		try {
			if (manager.type === 'apk') {
				await execOrThrow(
					manager.bin,
					forceReinstall
						? ['add', '--force-reinstall', '--allow-untrusted', tmpPath]
						: ['add', tmpPath, '--allow-untrusted'],
					_('Failed to install Simo package.')
				);
			} else {
				await execOrThrow(
					manager.bin,
					forceReinstall
						? ['--force-reinstall', 'install', tmpPath]
						: ['install', tmpPath],
					_('Failed to install Simo package.')
				);
			}
		} catch (e) {
			if (!isRpcReconnectLikeError(e.message)) throw e;
			notify('info', _('Connection interrupted while finalizing Simo update. Reloading interface...'));
			setTimeout(() => {
				window.location.reload();
			}, 3000);
			return true;
		}

		notify('info', _('Simo package downloaded and installed.'));
		notify('info', _('Simo package installed. Reloading interface...'));
		setTimeout(() => {
			window.location.reload();
		}, 1500);
		return true;
	} finally {
		try { await fs.remove(tmpPath); } catch (e) {}
	}
}

async function downloadMihomoKernel(downloadUrl, version, arch) {
	const safeVersion = String(version || '').replace(/[^\w.-]/g, '');
	const fileName = 'mihomo-linux-' + arch + '-' + safeVersion + '.gz';
	const downloadPath = '/tmp/simo-' + fileName;
	const extractedFile = downloadPath.replace(/\.gz$/, '');
	const targetFile = '/opt/simo/bin/mihomo';

	try {
		notify('info', _('Downloading mihomo kernel...'));

		const curlResult = await fs.exec('/usr/bin/curl', ['-L', '-fsS', downloadUrl, '-o', downloadPath]);
		if (curlResult.code !== 0) {
			throw new Error(String(curlResult.stderr || curlResult.stdout || _('Download failed')).trim());
		}

		const extractResult = await fs.exec('/bin/gzip', ['-df', downloadPath]);
		if (extractResult.code !== 0) {
			throw new Error(String(extractResult.stderr || extractResult.stdout || _('Extraction failed')).trim());
		}

		await fs.exec('/bin/mv', [extractedFile, targetFile]);
		await fs.exec('/bin/chmod', ['+x', targetFile]);
		await syncActiveCoreLink();

		notify('info', _('Mihomo kernel downloaded and installed.'));
		return true;
	} catch (e) {
		notify('error', _('Kernel download failed: %s').format(e.message));
		return false;
	} finally {
		try { await fs.remove(downloadPath); } catch (removeErr) {}
	}
}

async function downloadSingboxKernel(downloadUrl, version, arch, assetName) {
	const safeVersion = String(version || '').replace(/[^\w.-]/g, '');
	const archiveName = String(assetName || ('sing-box-' + safeVersion + '-linux-' + arch + '.tar.gz')).replace(/[^\w.-]/g, '');
	const downloadPath = '/tmp/simo-' + archiveName;
	const extractDir = '/tmp/simo-singbox-' + Date.now();
	const extractedDirName = archiveName.replace(/\.tar\.gz$/, '');
	let extractedBinary = extractDir + '/' + extractedDirName + '/sing-box';
	const targetFile = '/opt/simo/bin/sing-box';

	try {
		notify('info', _('Downloading sing-box kernel...'));

		await execOrThrow('/usr/bin/curl', ['-L', '-fsS', downloadUrl, '-o', downloadPath], _('Download failed'));
		await execOrThrow('/bin/mkdir', ['-p', extractDir], _('Failed to prepare extraction directory'));
		await execOrThrow('/bin/sh', ['-c', 'tar -xzf "' + downloadPath + '" -C "' + extractDir + '"'], _('Extraction failed'));

		const stat = await L.resolveDefault(fs.stat(extractedBinary), null);
		if (!stat) {
			const findResult = await fs.exec('/bin/sh', ['-c', 'find "' + extractDir + '" -type f -name sing-box | head -n 1']);
			const found = String(findResult.stdout || '').trim();
			if (!found) throw new Error(_('Extraction failed'));
			extractedBinary = found;
		}

		await execOrThrow('/bin/mv', [extractedBinary, targetFile], _('Failed to install sing-box binary'));
		await execOrThrow('/bin/chmod', ['+x', targetFile], _('Failed to mark sing-box executable'));
		await syncActiveCoreLink('sing-box');

		notify('info', _('sing-box kernel downloaded and installed.'));
		return true;
	} catch (e) {
		notify('error', _('Kernel download failed: %s').format(e.message));
		return false;
	} finally {
		try { await fs.remove(downloadPath); } catch (removeErr) {}
		await L.resolveDefault(fs.exec('/bin/sh', ['-c', 'rm -rf "' + extractDir + '"']), null);
	}
}

async function installKernelFromSettings(coreType) {
	const kernel = normalizeKernelType(coreType || getActiveCoreType());
	const adapter = getKernelAdapter(kernel);
	const arch = await detectSystemArchitecture();
	const release = await getLatestKernelRelease(kernel);
	const asset = findKernelAssetForCore(kernel, release, arch);

	if (!release) throw new Error(_('Failed to load kernel information: %s').format(_('Unavailable')));
	if (!asset || !asset.browser_download_url) throw new Error(_('Failed to load kernel information: %s').format(_('Download failed')));

	const ok = adapter.installFromAsset
		? await adapter.installFromAsset(asset, release.version, arch)
		: false;
	if (!ok) return false;

	try {
		if (appState.serviceRunning) {
			await execService('restart');
			notify('info', _('Kernel installed and service restarted.'));
		} else {
			notify('info', _('Kernel installed successfully.'));
		}
	} catch (e) {
		notify('error', _('Kernel installed, but failed to restart service: %s').format(e.message));
	}

	appState.kernelStatus = await getKernelStatus();
	appState.versions.core = (appState.kernelStatus && appState.kernelStatus.version) || appState.versions.core;
	await refreshHeaderAndControl();
	await refreshReleaseMeta({ force: true });
	return true;
}

function showModal(options) {
	const overlayClass = 'sbox-modal-overlay' + (options.overlayClass ? ' ' + options.overlayClass : '');
	const modalClass = 'sbox-modal' + (options.modalClass ? ' ' + options.modalClass : '');
	const dismissible = options.dismissible !== false;
	const overlay = E('div', { 'class': overlayClass });
	const modal = E('div', { 'class': modalClass });
	const titleNode = E('div', { 'class': 'sbox-modal-title' }, String(options.title || ''));
	const bodyNode = options.body && options.body.nodeType
		? options.body
		: E('div', { 'class': 'sbox-modal-body' }, String(options.body || ''));
	const actionsNode = E('div', { 'class': 'sbox-modal-actions' });
	let isClosed = false;

	function closeModal() {
		if (isClosed) return;
		isClosed = true;
		document.removeEventListener('keydown', onKeyDown);
		if (options.onClose) {
			try { options.onClose(); } catch (e) {}
		}
		overlay.remove();
	}

	function onKeyDown(ev) {
		if (dismissible && ev.key === 'Escape') closeModal();
	}

	(options.buttons || []).forEach((item) => {
		const button = E('button', {
			'class': item.className || 'cbi-button cbi-button-neutral'
		}, String(item.label || ''));

		button.addEventListener('click', async function(ev) {
			ev.preventDefault();
			if (item.onClick) {
				const oldText = button.textContent;
				button.disabled = true;
				try {
					await item.onClick({ closeModal: closeModal, button: button });
				} finally {
					if (button.isConnected) {
						button.disabled = false;
						button.textContent = oldText;
					}
				}
			} else {
				closeModal();
			}
		});

		actionsNode.appendChild(button);
	});

	modal.appendChild(titleNode);
	modal.appendChild(bodyNode);
	modal.appendChild(actionsNode);
	overlay.appendChild(modal);

	overlay.addEventListener('click', function(ev) {
		if (dismissible && ev.target === overlay) closeModal();
	});
	document.addEventListener('keydown', onKeyDown);

	if (pageRoot && pageRoot.appendChild) {
		pageRoot.appendChild(overlay);
	} else {
		document.body.appendChild(overlay);
	}
	return closeModal;
}

async function openKernelModal() {
	try {
		const activeCore = getActiveCoreType();
		const [kernelStatus, arch, release] = await Promise.all([
			getKernelStatus(),
			detectSystemArchitecture(),
			getLatestKernelRelease(activeCore)
		]);

		const status = kernelStatus.cores[activeCore] || { installed: false, version: null };
		const asset = findKernelAssetForCore(activeCore, release, arch);
		const localVersion = normalizeVersion(status.version || '');
		const latestVersion = normalizeVersion(release ? release.version : '');

		let downloadLabel = _('Download Kernel');
		if (status.installed && release && localVersion && latestVersion && localVersion === latestVersion) {
			downloadLabel = _('Reinstall Kernel');
		} else if (status.installed && release) {
			downloadLabel = _('Download Update');
		}

		const info = E('div', { 'class': 'sbox-modal-body' }, [
			E('div', {}, _('Status: %s').format(status.installed ? _('Installed') : _('Not installed'))),
			E('div', {}, _('Installed version: %s').format(status.installed ? status.version : _('Not installed'))),
			E('div', {}, _('Architecture: %s').format(arch)),
			E('div', {}, _('Latest release: %s').format(release ? release.version : _('Unavailable')))
		]);

		const buttons = [];
		if (release && asset) {
			buttons.push({
				label: downloadLabel,
				className: 'cbi-button cbi-button-apply',
				onClick: async function(ctx) {
					ctx.button.textContent = _('Downloading...');
					const ok = await installKernelFromSettings(activeCore);
					if (ok) {
						await refreshHeaderAndControl();
						ctx.closeModal();
					}
				}
			});
		}

		buttons.push({
			label: _('Close'),
			className: 'cbi-button cbi-button-neutral'
		});

		showModal({
			title: _('Kernel Settings'),
			body: info,
			buttons: buttons
		});
	} catch (e) {
		notify('error', _('Failed to load kernel information: %s').format(e.message));
	}
}

async function ensureKernelFirstRunPrompt() {
	if (firstRunKernelPromptShown) return;

	const cores = (appState.kernelStatus && appState.kernelStatus.cores) || {};
	const hasMihomo = !!(cores.mihomo && cores.mihomo.installed);
	const hasSingbox = !!(cores['sing-box'] && cores['sing-box'].installed);
	if (hasMihomo || hasSingbox) return;

	firstRunKernelPromptShown = true;
	const arch = await detectSystemArchitecture();
	const body = E('div', { 'class': 'sbox-modal-body' }, [
		E('div', {}, _('No kernel is installed yet. You must choose a core to continue.')),
		E('div', { 'style': 'margin-top:6px;' }, _('Architecture: %s').format(arch)),
		E('div', { 'style': 'margin-top:10px;' }, _('Core compatibility notes:')),
		E('ul', { 'style': 'margin:6px 0 0 18px; padding:0;' }, [
			E('li', {}, _('`mihomo`: best compatibility with existing YAML profile providers and rule flows.')),
			E('li', {}, _('`sing-box`: integrated runtime, but some third-party subscription outputs may still require `/mihomo` YAML export.'))
		])
	]);

	const installCore = async function(coreType, ctx) {
		ctx.button.textContent = _('Installing...');
		await setActiveKernel(coreType);
		await refreshHeaderAndControl();
		const ok = await installKernelFromSettings(coreType);
		if (ok) ctx.closeModal();
	};

	showModal({
		title: _('First Run: Install Kernel'),
		body: body,
		dismissible: false,
		buttons: [
			{
				label: _('Install mihomo'),
				className: 'cbi-button cbi-button-apply',
				onClick: async function(ctx) {
					await installCore('mihomo', ctx);
				}
			},
			{
				label: _('Install sing-box'),
				className: 'cbi-button cbi-button-apply',
				onClick: async function(ctx) {
					await installCore('sing-box', ctx);
				}
			}
		]
	});
}

async function withButtons(btns, fn) {
	const list = Array.isArray(btns) ? btns : (btns ? [btns] : []);
	const saved = list.map((b) => b.innerHTML);

	list.forEach((b) => {
		b.disabled = true;
		b.innerHTML = '<span class="sbox-spinner"></span> ' + safeText(b.textContent || '').trim();
	});

	try {
		return await fn();
	} finally {
		list.forEach((b, i) => {
			if (b && b.isConnected) {
				b.disabled = false;
				b.innerHTML = saved[i];
			}
		});
	}
}

function parseYamlValue(yaml, key) {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp('^\\s*' + escapedKey + '\\s*:\\s*(["\\\']?)([^#\\r\\n]+?)\\1\\s*(?:#.*)?$', 'm');
	const m = String(yaml || '').match(re);
	return m ? m[2].trim() : null;
}

function normalizeHostPortFromAddr(addr, fallbackHost, fallbackPort) {
	if (!addr) return { host: fallbackHost, port: fallbackPort };
	const cleaned = addr.replace(/["']/g, '').trim();
	const hostPort = cleaned.replace(/^\[|\]$/g, '');
	const lastColon = hostPort.lastIndexOf(':');
	let host = fallbackHost;
	let port = fallbackPort;

	if (lastColon !== -1) {
		host = hostPort.slice(0, lastColon);
		port = hostPort.slice(lastColon + 1);
	}
	if (host === '0.0.0.0' || host === '::' || host === '') host = fallbackHost;
	return { host, port };
}

function computeUiPath(externalUiName, externalUi) {
	if (externalUiName) {
		const name = externalUiName.replace(/(^\/+|\/+$)/g, '');
		return '/' + name + '/';
	}
	if (externalUi && !/[\/\\\.]/.test(externalUi)) {
		const name = externalUi.trim();
		return '/' + name + '/';
	}
	return '/ui/';
}

async function getServiceStatus() {
	try {
		const instances = (await callServiceList('simo')).simo?.instances;
		return Object.values(instances || {})[0]?.running || false;
	} catch (e) {
		return false;
	}
}

async function execService(action) {
	return fs.exec('/etc/init.d/simo', [action]);
}

async function execServiceOrThrow(action) {
	const result = await execService(action);
	if (result && typeof result.code === 'number' && result.code !== 0) {
		throw new Error(String(result.stderr || result.stdout || _('Service command failed')).trim());
	}
	return result;
}

function looksLikeBase64Text(value) {
	const cleaned = String(value || '').replace(/\s+/g, '');
	if (cleaned.length < 64 || cleaned.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/=]+$/.test(cleaned);
}

function tryDecodeBase64(value) {
	try {
		if (typeof atob !== 'function') return null;
		const cleaned = String(value || '').replace(/\s+/g, '');
		return atob(cleaned);
	} catch (e) {
		return null;
	}
}

function looksLikeUriSubscription(value) {
	const content = String(value || '');
	return /(?:^|\n)\s*(vmess|vless|trojan|ss|ssr|hysteria|hysteria2|tuic):\/\/[^\s]+/i.test(content);
}

function looksLikeBase64Blob(text) {
	const compact = String(text || '').replace(/\s+/g, '');
	if (compact.length < 48) return false;
	if (String(text || '').indexOf(':') !== -1) return false;
	return /^[A-Za-z0-9+/=]+$/.test(compact);
}

async function getOpenWrtReleaseVersion() {
	try {
		const release = await fs.read('/etc/openwrt_release');
		const line = String(release || '').split('\n').find((item) => item.indexOf('DISTRIB_RELEASE=') === 0);
		return line ? line.split('=')[1].replace(/["']/g, '').trim() : '';
	} catch (e) {
		return '';
	}
}

async function getSystemModel() {
	try {
		return String(await fs.read('/tmp/sysinfo/model') || '').trim();
	} catch (e) {
		return '';
	}
}

async function getHwidHash() {
	const probes = [
		"cat /sys/class/net/eth0/address 2>/dev/null | tr -d ':' | md5sum | cut -c1-14",
		"for i in /sys/class/net/*/address; do n=\"${i%/address}\"; n=\"${n##*/}\"; [ \"$n\" = \"lo\" ] && continue; cat \"$i\" 2>/dev/null | tr -d ':' | md5sum | cut -c1-14 && break; done"
	];

	for (let i = 0; i < probes.length; i++) {
		try {
			const r = await fs.exec('/bin/sh', ['-c', probes[i]]);
			if (r.code === 0) {
				const hwid = String(r.stdout || '').trim();
				if (hwid && hwid !== 'unknown') return hwid;
			}
		} catch (e) {}
	}

	return '';
}

function buildSubscriptionClientProfile(settings, appVersion) {
	const safeVersion = /^\d+\.\d+\.\d+/.test(String(appVersion || '')) ? String(appVersion) : '1.0.0';
	const settingsUa = String(settings.HWID_USER_AGENT || '').trim();
	return { ua: settingsUa || ('Simo/' + safeVersion) };
}

function normalizeSubscriptionDownloadUrl(rawUrl) {
	let parsed = null;
	try {
		parsed = new URL(rawUrl);
	} catch (e) {
		return { url: rawUrl, mode: 'direct', remnawaveCandidateUrl: null, fallbackOnError: false };
	}

	const segments = parsed.pathname.split('/').filter(Boolean);
	const lastSegment = String(segments[segments.length - 1] || '').toLowerCase();
	if (lastSegment === 'mihomo') {
		return {
			url: parsed.toString(),
			mode: 'remnawave-client-path',
			remnawaveCandidateUrl: null,
			fallbackOnError: false
		};
	}

	const subIndex = segments.indexOf('sub');
	if (subIndex < 0 || !segments[subIndex + 1]) {
		const genericCandidate = new URL(parsed.toString());
		genericCandidate.pathname = '/' + segments.concat('mihomo').join('/');
		return {
			url: parsed.toString(),
			mode: 'direct',
			remnawaveCandidateUrl: genericCandidate.toString(),
			fallbackOnError: false
		};
	}

	const clientType = String(segments[subIndex + 2] || '').toLowerCase();

	if (clientType === 'mihomo') {
		return {
			url: parsed.toString(),
			mode: 'remnawave-client-path',
			remnawaveCandidateUrl: null,
			fallbackOnError: false
		};
	}

	if (clientType) {
		const candidateSegments = segments.slice();
		candidateSegments[subIndex + 2] = 'mihomo';

		const candidate = new URL(parsed.toString());
		candidate.pathname = '/' + candidateSegments.join('/');

		return {
			url: parsed.toString(),
			mode: 'direct',
			remnawaveCandidateUrl: candidate.toString(),
			fallbackOnError: true
		};
	}

	const candidateSegments = segments.slice();
	candidateSegments.push('mihomo');

	const candidate = new URL(parsed.toString());
	candidate.pathname = '/' + candidateSegments.join('/');

	return {
		url: parsed.toString(),
		mode: 'direct',
		remnawaveCandidateUrl: candidate.toString(),
		fallbackOnError: true
	};
}

async function buildSubscriptionDeviceHeaders(settings) {
	const headers = {};
	const deviceOs = String(settings.HWID_DEVICE_OS || 'OpenWrt').trim() || 'OpenWrt';
	headers['x-device-os'] = deviceOs;

	const release = await getOpenWrtReleaseVersion();
	if (release) headers['x-ver-os'] = release;

	const model = await getSystemModel();
	if (model) headers['x-device-model'] = model;

	if (String(settings.ENABLE_HWID || '').toLowerCase() === 'true') {
		const hwid = await getHwidHash();
		if (hwid) headers['x-hwid'] = hwid;
	}

	return headers;
}

async function downloadSubscriptionWithProfile(url, profile, deviceHeaders, mode) {
	const args = [
		'-L', '-fsS',
		'--connect-timeout', String(SUBSCRIPTION_CURL_CONNECT_TIMEOUT_SEC),
		'--max-time', String(SUBSCRIPTION_CURL_MAX_TIME_SEC),
		'-A', profile.ua,
		'-H', 'Accept: application/yaml, text/yaml, text/plain, */*',
		'-H', 'Cache-Control: no-cache',
		'-H', 'Pragma: no-cache'
	];

	Object.keys(deviceHeaders || {}).forEach((key) => {
		const value = String(deviceHeaders[key] || '').trim();
		if (!value) return;
		args.push('-H');
		args.push(key + ': ' + value);
	});

	args.push(url);
	args.push('-o');
	args.push(TMP_SUBSCRIPTION_PATH);

	const dl = await fs.exec('/usr/bin/curl', args);
	if (dl.code !== 0) {
		const msg = String(dl.stderr || dl.stdout || _('Download failed')).trim();
		if (mode === 'remnawave-client-path' && /403/.test(msg)) {
			throw new Error(_('Remnawave blocked /mihomo path (HTTP 403). Disable "Disable Subscription Access by Path" in Remnawave response-rules settings.'));
		}
		throw new Error(msg);
	}

	const catResult = await fs.exec('/bin/cat', [TMP_SUBSCRIPTION_PATH]);
	if (catResult.code !== 0) {
		throw new Error(String(catResult.stderr || catResult.stdout || _('Unable to read downloaded file')).trim());
	}

	return String(catResult.stdout || '');
}

function looksLikeYamlConfig(content) {
	const text = String(content || '');
	return /(^|\n)\s*(proxies|proxy-providers|mixed-port|port|mode|rules):\s*/m.test(text);
}

function extractTestError(testResult) {
	const rawDetail = String(testResult?.stderr || testResult?.stdout || '').trim();
	if (!rawDetail) return 'unknown error';

	const lines = rawDetail.split('\n').filter((l) => l.trim().length > 0);
	for (let i = 0; i < lines.length; i++) {
		const msgMatch = lines[i].match(/msg="([^"]+)"/);
		if (msgMatch) return msgMatch[1].trim();
	}
	return lines[lines.length - 1].trim();
}

async function runMihomoValidation(configPath) {
	const baseArgs = ['-d', '/opt/simo', '-f', configPath, '-t'];
	let result;

	try {
		result = await fs.exec('/opt/simo/bin/mihomo', baseArgs);
	} catch (e) {
		result = await fs.exec('/opt/simo/bin/core', baseArgs);
	}

	if (result.code !== 0 && configPath === CONFIG_PATH) {
		try {
			result = await fs.exec('/opt/simo/bin/mihomo', ['-d', '/opt/simo', '-t']);
		} catch (e) {
			result = await fs.exec('/opt/simo/bin/core', ['-d', '/opt/simo', '-t']);
		}
	}

	return result;
}

async function runSingboxValidation(configPath) {
	let result;

	try {
		result = await fs.exec(SIMO_RUNTIME_BIN, ['validate-path', configPath, 'sing-box']);
		if (result.code === 0) return result;
	} catch (e) {}

	result = await fs.exec('/opt/simo/bin/sing-box', ['check', '-c', configPath, '-D', '/opt/simo']);
	if (result.code !== 0) {
		result = await fs.exec('/opt/simo/bin/sing-box', ['-D', '/opt/simo', '-c', configPath, 'check']);
	}

	return result;
}

async function testConfigContent(content, keepOnSuccess, targetPath) {
	const normalized = String(content || '').trimEnd() + '\n';
	const configPath = String(targetPath || CONFIG_PATH);
	const lowerConfigPath = configPath.toLowerCase();
	const isSingboxConfig = configPath === SINGBOX_CONFIG_PATH || lowerConfigPath.endsWith('.json');
	let original = '';

	try {
		original = await fs.read(configPath);
	} catch (e) {
		original = '';
	}

	try {
		await fs.write(configPath, normalized);
		await setFileMode(configPath);
		const testResult = isSingboxConfig
			? await runSingboxValidation(configPath)
			: await runMihomoValidation(configPath);

		if (testResult.code !== 0) {
			await fs.write(configPath, original);
			await setFileMode(configPath);
			return { ok: false, message: extractTestError(testResult) };
		}

		if (!keepOnSuccess) {
			await fs.write(configPath, original);
			await setFileMode(configPath);
		}
		return { ok: true, message: '' };
	} catch (e) {
		try {
			await fs.write(configPath, original);
			await setFileMode(configPath);
		} catch (restoreError) {}
		return { ok: false, message: e.message || 'test failed' };
	}
}

async function fetchSubscriptionAsYaml(url, targetPath) {
	const settingsMap = await readSettingsMap();
	const versions = await getVersions();
	const profile = buildSubscriptionClientProfile(settingsMap, versions.app);
	const deviceHeaders = await buildSubscriptionDeviceHeaders(settingsMap);
	const resolved = normalizeSubscriptionDownloadUrl(url);
	let mode = resolved.mode;
	let payload = '';
	let primaryError = null;

	try {
		payload = await downloadSubscriptionWithProfile(resolved.url, profile, deviceHeaders, mode);
	} catch (e) {
		primaryError = e;
	}

	const needsFallbackByPayload = !primaryError &&
		(looksLikeBase64Blob(payload) || looksLikeUriSubscription(payload));
	const shouldTryFallback = !!resolved.remnawaveCandidateUrl &&
		(needsFallbackByPayload || (primaryError && resolved.fallbackOnError));

	if (shouldTryFallback) {
		try {
			payload = await downloadSubscriptionWithProfile(
				resolved.remnawaveCandidateUrl,
				profile,
				deviceHeaders,
				'remnawave-client-path'
			);
			mode = 'remnawave-client-path';
			primaryError = null;
		} catch (fallbackError) {
			if (primaryError) {
				throw new Error(_('Subscription download failed for both original URL and /mihomo fallback: %s').format(fallbackError.message));
			}
			throw new Error(_('Original URL returned links/base64 and /mihomo fallback failed: %s').format(fallbackError.message));
		}
	}

	if (primaryError) throw primaryError;
	if (!payload.trim()) throw new Error(_('Downloaded file is empty.'));

	if (looksLikeBase64Blob(payload)) {
		const decoded = tryDecodeBase64(payload);
		if (decoded && looksLikeYamlConfig(decoded)) {
			payload = decoded;
		}
	}

	if (looksLikeBase64Blob(payload) || looksLikeUriSubscription(payload)) {
		if (mode === 'remnawave-client-path') {
			throw new Error(_('Both original URL and /mihomo returned links/base64 instead of Mihomo YAML. Check provider export type.'));
		}
		throw new Error(_('The subscription server returned links/base64 instead of Mihomo YAML. For Remnawave use the /mihomo subscription path.'));
	}

	const tested = await testConfigContent(payload, false, targetPath || CONFIG_PATH);
	if (!tested.ok) throw new Error(tested.message || _('YAML validation failed.'));

	return { content: payload, mode: mode };
}

async function openDashboard() {
	try {
		if (!(await getServiceStatus())) {
			notify('error', _('Service is not running.'));
			return;
		}

		const config = await fs.read(CONFIG_PATH);
		const ec = parseYamlValue(config, 'external-controller');
		const ecTls = parseYamlValue(config, 'external-controller-tls');
		const secret = parseYamlValue(config, 'secret');
		const externalUi = parseYamlValue(config, 'external-ui');
		const externalUiName = parseYamlValue(config, 'external-ui-name');

		const baseHost = window.location.hostname;
		const basePort = '9090';
		const useTls = !!ecTls;

		const hostPort = normalizeHostPortFromAddr(useTls ? ecTls : ec, baseHost, basePort);
		const scheme = useTls ? 'https:' : 'http:';
		const uiPath = computeUiPath(externalUiName, externalUi);

		const qp = new URLSearchParams();
		if (secret) qp.set('secret', secret);
		qp.set('hostname', hostPort.host);
		qp.set('port', hostPort.port);

		const url = scheme + '//' + hostPort.host + ':' + hostPort.port + uiPath + '?' + qp.toString();
		const popup = window.open(url, '_blank');

		if (!popup) {
			notify('warning', _('Popup was blocked. Please allow popups for this site.'));
		}
	} catch (e) {
		notify('error', _('Failed to open dashboard: %s').format(e.message));
	}
}

function createInterfaceEntry(name) {
	let category = 'other';

	if (/\.\d+$/.test(name) || /^(br-|bridge|eth|lan|switch|bond|team)/.test(name)) {
		category = 'ethernet';
	} else if (/^(wlan|wifi|ath|phy|ra|mt|rtl|iwl)/.test(name)) {
		category = 'wifi';
	} else if (/^(wan|ppp|modem|3g|4g|5g|lte|gsm|cdma|hsdpa|hsupa|umts)/.test(name)) {
		category = 'wan';
	} else if (/^(tun|tap|vpn|wg|ovpn|openvpn|l2tp|pptp|sstp|ikev2|ipsec)/.test(name)) {
		category = 'vpn';
	} else if (/^(veth|macvlan|ipvlan|dummy|vrf|vcan|vxcan)/.test(name)) {
		category = 'virtual';
	}

	return {
		name: name,
		category: category,
		description: name
	};
}

async function getNetworkInterfaces() {
	const result = [];
	const seen = new Set();

	const pushIface = (name) => {
		const clean = String(name || '').trim();
		if (!clean || clean === 'lo' || clean === 'simo-tun' || seen.has(clean)) return;
		seen.add(clean);
		result.push(createInterfaceEntry(clean));
	};

	try {
		const r = await fs.exec('ls', ['/sys/class/net/']);
		if (r.code === 0 && r.stdout) {
			String(r.stdout).split('\n').forEach(pushIface);
		}
	} catch (e) {}

	try {
		const r = await fs.exec('ip', ['link', 'show']);
		if (r.code === 0 && r.stdout) {
			String(r.stdout).split('\n').forEach((line) => {
				const m = line.match(/^\d+:\s+([^:@]+)/);
				if (m && m[1]) pushIface(m[1]);
			});
		}
	} catch (e) {}

	try {
		const devices = await network.getDevices();
		devices.forEach((dev) => {
			const n = dev.getName && dev.getName();
			if (n) pushIface(n);
		});
	} catch (e) {}

	try {
		const nets = await network.getNetworks();
		nets.forEach((net) => {
			const dev = net.getL3Device && net.getL3Device();
			const n = dev && dev.getName && dev.getName();
			if (n) pushIface(n);
		});
	} catch (e) {}

	const order = ['wan', 'ethernet', 'wifi', 'vpn', 'virtual', 'other'];
	return result.sort((a, b) => {
		const ca = order.indexOf(a.category);
		const cb = order.indexOf(b.category);
		if (ca !== cb) return ca - cb;
		return a.name.localeCompare(b.name);
	});
}

async function getHwidValues() {
	try {
		let hwid = 'unknown';
		try {
			const macResult = await fs.exec('/bin/sh', ['-c',
				"cat /sys/class/net/eth0/address 2>/dev/null | tr -d ':' | md5sum | cut -c1-14"
			]);
			if (macResult.code === 0 && macResult.stdout) hwid = macResult.stdout.trim();
		} catch (e) {}

		let verOs = 'unknown';
		try {
			const verResult = await fs.exec('/bin/sh', ['-c',
				'. /etc/openwrt_release && echo $DISTRIB_RELEASE'
			]);
			if (verResult.code === 0 && verResult.stdout) verOs = verResult.stdout.trim();
		} catch (e) {}

		let deviceModel = 'Router';
		try {
			const modelResult = await fs.exec('/bin/sh', ['-c', 'cat /tmp/sysinfo/model 2>/dev/null']);
			if (modelResult.code === 0 && modelResult.stdout) deviceModel = modelResult.stdout.trim();
		} catch (e) {}

		return { hwid, verOs, deviceModel };
	} catch (e) {
		return { hwid: 'unknown', verOs: 'unknown', deviceModel: 'Router' };
	}
}

function addHwidToYaml(yamlContent, userAgent, deviceOS, hwid, verOs, deviceModel) {
	const lines = String(yamlContent || '').split('\n');
	const result = [];
	let inProxyProviders = false;
	let inProvider = false;
	let currentProvider = [];
	let hasHeader = false;

	function flushProvider() {
		result.push(...currentProvider);
		if (!hasHeader) {
			while (result.length > 0 && result[result.length - 1].trim() === '') result.pop();
			result.push('    header:');
			result.push('      User-Agent: [' + userAgent + ']');
			result.push('      x-hwid: [' + hwid + ']');
			result.push('      x-device-os: [' + deviceOS + ']');
			result.push('      x-ver-os: [' + verOs + ']');
			result.push('      x-device-model: [' + deviceModel + ']');
			result.push('');
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (/^proxy-providers:\s*$/.test(line)) {
			inProxyProviders = true;
			result.push(line);
			continue;
		}

		if (inProxyProviders) {
			if (/^[a-zA-Z]/.test(line)) {
				if (inProvider) flushProvider();
				inProxyProviders = false;
				inProvider = false;
				result.push(line);
				continue;
			}

			const providerMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
			if (providerMatch) {
				if (inProvider) flushProvider();
				currentProvider = [line];
				inProvider = true;
				hasHeader = false;
				continue;
			}

			if (inProvider && /^    header:\s*$/.test(line)) hasHeader = true;

			if (inProvider) {
				currentProvider.push(line);
			} else {
				result.push(line);
			}
		} else {
			result.push(line);
		}
	}

	if (inProvider) flushProvider();
	return result.join('\n');
}

function transformProxyMode(content, proxyMode, tunStack) {
	const lines = String(content || '').split('\n');
	const newLines = [];
	let inTunSection = false;
	let tunIndentLevel = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (/^#\s*Proxy\s+Mode:/i.test(trimmed)) continue;

		if (trimmed === '' && i + 1 < lines.length && lines[i + 1].trim() === '') continue;

		if (trimmed === '' && i + 1 < lines.length) {
			const nextLine = lines[i + 1].trim();
			if (/^#\s*Proxy\s+Mode:/i.test(nextLine) || /^tproxy-port/.test(nextLine) || /^tun:/.test(nextLine)) {
				continue;
			}
		}

		if (/^tproxy-port:/.test(trimmed)) continue;

		if (/^tun:/.test(trimmed)) {
			inTunSection = true;
			tunIndentLevel = line.search(/\S/);
			continue;
		}

		if (inTunSection) {
			const currentIndent = line.search(/\S/);
			if (line.trim() === '' || line.trim().startsWith('#') || (currentIndent > tunIndentLevel && line.trim() !== '')) {
				continue;
			}
			inTunSection = false;
		}

		newLines.push(line);
	}

	let insertIndex = 0;
	for (let i = 0; i < newLines.length; i++) {
		if (/^mode:/.test(newLines[i].trim())) {
			insertIndex = i + 1;
			break;
		}
	}

	const normalizedTunStack = ['system', 'gvisor', 'mixed'].includes(tunStack) ? tunStack : 'system';
	let configToInsert = [];

	switch (proxyMode) {
		case 'tproxy':
			configToInsert = ['# Proxy Mode: TPROXY', 'tproxy-port: 7894'];
			break;
		case 'tun':
			configToInsert = [
				'# Proxy Mode: TUN',
				'tun:',
				'  enable: true',
				'  device: simo-tun',
				'  stack: ' + normalizedTunStack,
				'  auto-route: false',
				'  auto-redirect: false',
				'  auto-detect-interface: false'
			];
			break;
		case 'mixed':
			configToInsert = [
				'# Proxy Mode: MIXED (TCP via TPROXY, UDP via TUN)',
				'tproxy-port: 7894',
				'tun:',
				'  enable: true',
				'  device: simo-tun',
				'  stack: ' + normalizedTunStack,
				'  auto-route: false',
				'  auto-redirect: false',
				'  auto-detect-interface: false'
			];
			break;
	}

	newLines.splice(insertIndex, 0, ...configToInsert);
	return newLines.join('\n');
}

async function detectCurrentProxyMode() {
	try {
		const configContent = await L.resolveDefault(fs.read(CONFIG_PATH), '');
		if (!configContent) return 'tproxy';

		const lines = configContent.split('\n');
		let hasTproxy = false;
		let hasTun = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			if (/^tproxy-port:/.test(trimmed) && !trimmed.startsWith('#')) hasTproxy = true;
			if (/^tun:/.test(trimmed)) {
				for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
					const next = lines[j].trim();
					if (/^enable:\s*true/.test(next)) {
						hasTun = true;
						break;
					}
					if (/^[a-zA-Z]/.test(next) && !next.startsWith('#')) break;
				}
			}
		}

		if (hasTproxy && hasTun) return 'mixed';
		if (hasTun) return 'tun';
		if (hasTproxy) return 'tproxy';
		return 'tproxy';
	} catch (e) {
		return 'tproxy';
	}
}

async function loadOperationalSettings() {
	try {
		const content = await L.resolveDefault(fs.read(SETTINGS_PATH), '');
		const settings = {
			mode: 'exclude',
			proxyMode: '',
			tunStack: 'system',
			autoDetectLan: true,
			autoDetectWan: true,
			blockQuic: true,
			useTmpfsRules: true,
			detectedLan: '',
			detectedWan: '',
			includedInterfaces: [],
			excludedInterfaces: [],
			enableHwid: false,
			hwidUserAgent: 'Simo',
			hwidDeviceOS: 'OpenWrt'
		};

		String(content || '').split('\n').forEach((line) => {
			const idx = line.indexOf('=');
			if (idx === -1) return;
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();

			switch (key) {
				case 'INTERFACE_MODE': settings.mode = value; break;
				case 'PROXY_MODE': settings.proxyMode = value; break;
				case 'TUN_STACK': settings.tunStack = value || 'system'; break;
				case 'AUTO_DETECT_LAN': settings.autoDetectLan = value === 'true'; break;
				case 'AUTO_DETECT_WAN': settings.autoDetectWan = value === 'true'; break;
				case 'BLOCK_QUIC': settings.blockQuic = value === 'true'; break;
				case 'USE_TMPFS_RULES': settings.useTmpfsRules = value === 'true'; break;
				case 'DETECTED_LAN': settings.detectedLan = value; break;
				case 'DETECTED_WAN': settings.detectedWan = value; break;
				case 'INCLUDED_INTERFACES':
					settings.includedInterfaces = value ? value.split(',').map((i) => i.trim()).filter(Boolean) : [];
					break;
				case 'EXCLUDED_INTERFACES':
					settings.excludedInterfaces = value ? value.split(',').map((i) => i.trim()).filter(Boolean) : [];
					break;
				case 'ENABLE_HWID': settings.enableHwid = value === 'true'; break;
				case 'HWID_USER_AGENT': settings.hwidUserAgent = value || 'Simo'; break;
				case 'HWID_DEVICE_OS': settings.hwidDeviceOS = value || 'OpenWrt'; break;
			}
		});

		return settings;
	} catch (e) {
		return {
			mode: 'exclude',
			proxyMode: '',
			tunStack: 'system',
			autoDetectLan: true,
			autoDetectWan: true,
			blockQuic: true,
			useTmpfsRules: true,
			detectedLan: '',
			detectedWan: '',
			includedInterfaces: [],
			excludedInterfaces: [],
			enableHwid: false,
			hwidUserAgent: 'Simo',
			hwidDeviceOS: 'OpenWrt'
		};
	}
}

async function loadInterfacesByMode(mode) {
	const settings = await loadOperationalSettings();
	const manualList = mode === 'explicit' ? settings.includedInterfaces : settings.excludedInterfaces;
	const detected = mode === 'explicit' ? settings.detectedLan : settings.detectedWan;

	const all = manualList.slice();
	if (detected && !all.includes(detected)) all.push(detected);
	return all;
}

async function detectLanBridge() {
	try {
		try {
			const nets = await network.getNetworks();
			for (let i = 0; i < nets.length; i++) {
				const net = nets[i];
				if (net.getName && net.getName() === 'lan') {
					const dev = net.getL3Device && net.getL3Device();
					if (dev && dev.getName && dev.getName()) return dev.getName();
				}
			}
		} catch (e) {}

		const ipResult = await fs.exec('ip', ['addr', 'show']);
		if (ipResult.code === 0 && ipResult.stdout) {
			const lines = String(ipResult.stdout).split('\n');
			let currentIface = '';

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const ifaceMatch = line.match(/^\d+:\s+([^:@]+):/);
				if (ifaceMatch) {
					currentIface = ifaceMatch[1];
					continue;
				}

				const ipMatch = line.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
				if (ipMatch && currentIface && currentIface !== 'lo') {
					const ip = ipMatch[1];
					if (/^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) {
						if (/^(br-|bridge)/.test(currentIface) || currentIface === 'lan') return currentIface;
					}
				}
			}
		}

		return null;
	} catch (e) {
		return null;
	}
}

async function detectWanInterface() {
	try {
		try {
			const nets = await network.getNetworks();
			for (let i = 0; i < nets.length; i++) {
				const net = nets[i];
				if ((net.getName && net.getName() === 'wan') || (net.getName && net.getName() === 'wan6')) {
					const dev = net.getL3Device && net.getL3Device();
					if (dev && dev.getName && dev.getName()) return dev.getName();
				}
			}
		} catch (e) {}

		const routeContent = await L.resolveDefault(fs.read('/proc/net/route'), '');
		const lines = String(routeContent).split('\n');
		for (let i = 0; i < lines.length; i++) {
			const fields = lines[i].split('\t');
			if (fields[1] === '00000000' && fields[0] !== 'Iface') return fields[0];
		}

		return null;
	} catch (e) {
		return null;
	}
}

async function saveOperationalSettings(mode, proxyMode, tunStack, autoDetectLan, autoDetectWan, blockQuic, useTmpfsRules, interfaces, enableHwid, hwidUserAgent, hwidDeviceOS, options) {
	const opts = options || {};
	try {
		let detectedLan = '';
		let detectedWan = '';

		if (autoDetectLan) detectedLan = await detectLanBridge() || '';
		if (autoDetectWan) detectedWan = await detectWanInterface() || '';

		let cleanInterfaces = interfaces.slice();
		if (mode === 'explicit' && autoDetectLan && detectedLan) {
			cleanInterfaces = cleanInterfaces.filter((iface) => iface !== detectedLan);
		} else if (mode === 'exclude' && autoDetectWan && detectedWan) {
			cleanInterfaces = cleanInterfaces.filter((iface) => iface !== detectedWan);
		}

		const includedInterfaces = mode === 'explicit' ? cleanInterfaces : [];
		const excludedInterfaces = mode === 'exclude' ? cleanInterfaces : [];

		const settingsContent = [
			'INTERFACE_MODE=' + mode,
			'PROXY_MODE=' + proxyMode,
			'TUN_STACK=' + tunStack,
			'AUTO_DETECT_LAN=' + autoDetectLan,
			'AUTO_DETECT_WAN=' + autoDetectWan,
			'BLOCK_QUIC=' + blockQuic,
			'USE_TMPFS_RULES=' + useTmpfsRules,
			'DETECTED_LAN=' + detectedLan,
			'DETECTED_WAN=' + detectedWan,
			'INCLUDED_INTERFACES=' + includedInterfaces.join(','),
			'EXCLUDED_INTERFACES=' + excludedInterfaces.join(','),
			'ENABLE_HWID=' + enableHwid,
			'HWID_USER_AGENT=' + hwidUserAgent,
			'HWID_DEVICE_OS=' + hwidDeviceOS,
			''
		].join('\n');

		await fs.write(SETTINGS_PATH, settingsContent);
		await L.resolveDefault(fs.exec(SIMO_RUNTIME_BIN, ['prepare', 'sing-box']), null);

		const configContent = await L.resolveDefault(fs.read(CONFIG_PATH), '');
		if (configContent) {
			let updatedConfig = transformProxyMode(configContent, proxyMode, tunStack);
			if (enableHwid) {
				const hwidValues = await getHwidValues();
				updatedConfig = addHwidToYaml(
					updatedConfig,
					hwidUserAgent,
					hwidDeviceOS,
					hwidValues.hwid,
					hwidValues.verOs,
					hwidValues.deviceModel
				);
			}
			await fs.write(CONFIG_PATH, updatedConfig);
		}

			if (!opts.silent) {
				notify('info', _('Settings saved.'));
			}
			return true;
	} catch (e) {
		notify('error', _('Failed to save settings: %s').format(e.message));
		return false;
	}
}

function normalizeProxyMode(mode) {
	const normalized = String(mode || '').toLowerCase().trim();
	if (normalized === 'tun' || normalized === 'mixed' || normalized === 'tproxy') return normalized;
	return 'tproxy';
}

async function switchProxyModeFromHeader(targetMode) {
	const nextMode = normalizeProxyMode(targetMode);
	if (nextMode === appState.proxyMode) return;

	const current = await loadOperationalSettings();
	const interfaces = (current.mode === 'explicit'
		? (current.includedInterfaces || [])
		: (current.excludedInterfaces || [])
	).slice();

	const ok = await saveOperationalSettings(
		current.mode || 'exclude',
		nextMode,
		current.tunStack || 'system',
		!!current.autoDetectLan,
		!!current.autoDetectWan,
		!!current.blockQuic,
		!!current.useTmpfsRules,
		interfaces,
		!!current.enableHwid,
		current.hwidUserAgent || 'Simo',
		current.hwidDeviceOS || 'OpenWrt',
		{ silent: true }
	);

	if (!ok) throw new Error(_('Cannot save proxy mode.'));

	const activeCore = getActiveCoreType();
	await migrateCoreRuntime(activeCore);
	await validateCoreRuntime(activeCore);
	await execServiceOrThrow('restart');
	const healthy = await waitForRuntimeHealthy(activeCore, 15000, 1000);
	if (!healthy) {
		throw new Error(_('Service did not become healthy after restart.'));
	}

	appState.settings = await loadOperationalSettings();
	appState.selectedInterfaces = await loadInterfacesByMode(appState.settings.mode || 'exclude');
	appState.detectedLan = appState.settings.detectedLan || (await detectLanBridge()) || '';
	appState.detectedWan = appState.settings.detectedWan || (await detectWanInterface()) || '';
	appState.proxyMode = normalizeProxyMode(appState.settings.proxyMode || nextMode);
	appState.serviceRunning = await getServiceStatus();

	const freshConfig = await L.resolveDefault(
		fs.read(getConfigPathByName(appState.selectedConfigName)),
		''
	);
	appState.configContent = freshConfig;
	if (editor) {
		editor.setValue(String(freshConfig || ''), -1);
		editor.clearSelection();
	}

	updateHeaderAndControlDom();
	if (appState.activeCtrlTab === 'settings') renderSettingsPane();
	notify('info', _('Proxy mode switched to %s. Service restarted.').format(appState.proxyMode));
}

async function loadServiceLogs() {
	try {
		const direct = await fs.exec('/sbin/logread', ['-e', 'simo']);
		if (direct.code === 0) return String(direct.stdout || '').trim();
	} catch (e) {}

	try {
		const all = await fs.exec('/sbin/logread', []);
		if (all.code === 0) {
			return String(all.stdout || '')
				.split('\n')
				.filter((line) => /simo/i.test(line))
				.join('\n')
				.trim();
		}
	} catch (e) {}

	return '';
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SYSLOG_SIMO_RE = /^.*? ([\d:]{8}) .*?daemon\.(\w+)\s+(simo(?:-rules|-hotplug)?)\b(?:\[\d+\])?:\s*(.*)$/;

function normalizeLogMessage(message) {
	let text = String(message || '').trim();
	if (!text) return '';

	const msgOnly = text.match(/^msg="(.*)"$/);
	if (msgOnly) text = msgOnly[1];

	const coreMessage = text.match(/^time="[^"]+"\s+level=\w+\s+msg="(.*)"$/);
	if (coreMessage) text = coreMessage[1];

	return text.replace(/\\"/g, '"').trim();
}

function formatLogLine(line) {
	const raw = String(line || '').replace(ANSI_RE, '').trim();
	if (!raw) return null;

	const syslogMatch = raw.match(SYSLOG_SIMO_RE);
	if (syslogMatch) {
		const time = syslogMatch[1];
		const level = String(syslogMatch[2] || '').toUpperCase();
		const daemon = syslogMatch[3];
		const message = normalizeLogMessage(syslogMatch[4]);

		return {
			text: '[' + time + '] [' + daemon + '] [' + level + '] ' + message,
			level: level
		};
	}

	const coreRawMatch = raw.match(/^time="([^"]+)"\s+level=(\w+)\s+msg="(.*)"$/);
	if (coreRawMatch) {
		const isoTime = coreRawMatch[1];
		const level = String(coreRawMatch[2] || '').toUpperCase();
		const message = normalizeLogMessage(coreRawMatch[3]);
		const time = (isoTime.match(/(\d{2}:\d{2}:\d{2})/) || [null, '--:--:--'])[1];

		return {
			text: '[' + time + '] [simo] [' + level + '] ' + message,
			level: level
		};
	}

	if (!/simo/i.test(raw)) return null;

	const fallbackLevel =
		/\b(FATAL|PANIC|ERRO|ERROR)\b/i.test(raw) ? 'ERROR' :
		/\b(WARN|WARNING)\b/i.test(raw) ? 'WARN' :
		/\b(INFO)\b/i.test(raw) ? 'INFO' : 'MUTED';

	return { text: raw, level: fallbackLevel };
}

function colorizeLog(raw) {
	if (!raw) return '<span class="sbox-log-muted">No logs yet.</span>';

	const rows = String(raw || '').split('\n')
		.map((line) => formatLogLine(line))
		.filter((item) => !!item && !!item.text);

	if (!rows.length) return '<span class="sbox-log-muted">No logs yet.</span>';

	return rows.map((item) => {
		const esc = safeText(item.text);
		if (/(FATAL|PANIC|ERRO|ERROR)/i.test(item.level)) return '<span class="sbox-log-error">' + esc + '</span>';
		if (/(WARN|WARNING)/i.test(item.level)) return '<span class="sbox-log-warn">' + esc + '</span>';
		if (/(INFO)/i.test(item.level)) return '<span class="sbox-log-info">' + esc + '</span>';
		return '<span class="sbox-log-muted">' + esc + '</span>';
	}).join('\n');
}

function loadScript(src) {
	return new Promise((resolve, reject) => {
		if (document.querySelector('script[src="' + src + '"]')) {
			resolve();
			return;
		}

		const script = document.createElement('script');
		script.src = src;
		script.onload = resolve;
		script.onerror = reject;
		document.head.appendChild(script);
	});
}

async function initializeAceEditor(content) {
	await loadScript(ACE_BASE + 'ace.js');
	await loadScript(ACE_BASE + 'mode-yaml.js');

	ace.config.set('basePath', ACE_BASE);
	const editorHost = (pageRoot && pageRoot.querySelector('#simo-editor')) || document.getElementById('simo-editor');
	if (!editorHost) throw new Error('editor container #simo-editor not found');
	editor = ace.edit(editorHost);
	editor.session.setMode('ace/mode/yaml');
	editor.setValue(String(content || ''), -1);
	editor.clearSelection();
	editor.setOptions({
		fontSize: '12px',
		showPrintMargin: false,
		wrap: true,
		highlightActiveLine: true
	});
	applyEditorTheme();
}

function destroyRulesetEditors() {
	if (rulesetMainEditor) {
		try { rulesetMainEditor.destroy(); } catch (e) {}
		try { if (rulesetMainEditor.container) rulesetMainEditor.container.textContent = ''; } catch (e) {}
		rulesetMainEditor = null;
	}

	if (rulesetWhitelistEditor) {
		try { rulesetWhitelistEditor.destroy(); } catch (e) {}
		try { if (rulesetWhitelistEditor.container) rulesetWhitelistEditor.container.textContent = ''; } catch (e) {}
		rulesetWhitelistEditor = null;
	}
}

function normalizeRulesetName(rawName) {
	const clean = String(rawName || '').trim().replace(/\.txt$/i, '');
	if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean)) return '';
	return clean.toLowerCase();
}

function isEditableRulesetFile(fileName) {
	return /\.txt$/i.test(fileName) && fileName !== FAKEIP_WHITELIST_FILENAME;
}

async function detectFakeIpWhitelistMode() {
	try {
		const configContent = await L.resolveDefault(fs.read(CONFIG_PATH), '');
		if (!configContent) return false;

		let inDns = false;
		let dnsEnabled = false;
		let fakeIpMode = false;
		let filterMode = 'blacklist';

		String(configContent).split('\n').forEach((line) => {
			const trimmed = line.trim();

			if (/^dns:\s*$/.test(trimmed)) {
				inDns = true;
				return;
			}

			if (inDns && trimmed && !/^\s/.test(line)) {
				inDns = false;
			}
			if (!inDns) return;

			if (/^enable:\s*true/i.test(trimmed)) dnsEnabled = true;
			if (/^enhanced-mode:\s*fake-ip/i.test(trimmed)) fakeIpMode = true;

			const modeMatch = trimmed.match(/^fake-ip-filter-mode:\s*(\S+)/i);
			if (modeMatch) {
				filterMode = String(modeMatch[1] || '').toLowerCase().replace(/['"]/g, '');
			}
		});

		return dnsEnabled && fakeIpMode && filterMode === 'whitelist';
	} catch (e) {
		return false;
	}
}

async function readRulesetsData() {
	try {
		await fs.exec('/bin/mkdir', ['-p', RULESET_PATH]);
	} catch (e) {}

	const files = await L.resolveDefault(fs.list(RULESET_PATH), []);
	const rulesetNames = (files || [])
		.filter((item) => item && isEditableRulesetFile(item.name || ''))
		.map((item) => item.name)
		.sort((a, b) => a.localeCompare(b));

	const contentMap = {};
	for (let i = 0; i < rulesetNames.length; i++) {
		const name = rulesetNames[i];
		contentMap[name] = await L.resolveDefault(fs.read(RULESET_PATH + name), '');
	}

	const whitelistMode = await detectFakeIpWhitelistMode();
	let whitelistContent = '';

	if (whitelistMode) {
		const filePath = RULESET_PATH + FAKEIP_WHITELIST_FILENAME;
		const existing = await L.resolveDefault(fs.read(filePath), null);
		if (existing == null) {
			await fs.write(filePath, '');
		} else {
			whitelistContent = existing;
		}
	}

	return {
		rulesetNames: rulesetNames,
		contentMap: contentMap,
		whitelistMode: whitelistMode,
		whitelistContent: whitelistContent
	};
}

async function openRulesetsModal() {
	await loadScript(ACE_BASE + 'ace.js');
	await loadScript(ACE_BASE + 'mode-text.js');

	const data = await readRulesetsData();
	let rulesetNames = data.rulesetNames.slice();
	let currentRuleset = rulesetNames[0] || '';
	const rulesetCache = Object.assign({}, data.contentMap || {});

	const body = E('div', { 'class': 'sbox-modal-body sbox-rulesets-modal-body' });
	body.innerHTML = '' +
		'<div class="sbox-rulesets-layout">' +
			'<aside class="sbox-rulesets-sidebar">' +
				'<div class="sbox-rulesets-title">' + safeText(_('Local Rulesets')) + '</div>' +
				'<div class="sbox-muted">' + safeText(_('Manage local .txt lists for rule-providers.')) + '</div>' +
				'<div class="sbox-rulesets-create-row">' +
					'<input id="sbox-ruleset-new-name" class="cbi-input-text sbox-input" type="text" placeholder="' + safeText(_('new-list-name')) + '" />' +
					'<button id="sbox-ruleset-create" type="button" class="cbi-button cbi-button-positive">' + safeText(_('Create')) + '</button>' +
				'</div>' +
				'<div id="sbox-rulesets-list" class="sbox-rulesets-list"></div>' +
			'</aside>' +
			'<section class="sbox-rulesets-main">' +
				'<div class="sbox-rulesets-toolbar">' +
					'<span id="sbox-ruleset-current" class="sbox-ruleset-current"></span>' +
					'<div class="sbox-rulesets-toolbar-actions">' +
						'<button id="sbox-ruleset-save" type="button" class="cbi-button cbi-button-positive">' + safeText(_('Save')) + '</button>' +
						'<button id="sbox-ruleset-delete" type="button" class="cbi-button cbi-button-negative">' + safeText(_('Delete')) + '</button>' +
					'</div>' +
				'</div>' +
				'<div id="sbox-ruleset-empty" class="sbox-rulesets-empty">' + safeText(_('No ruleset selected. Create one to begin.')) + '</div>' +
				'<div id="sbox-ruleset-editor-wrap" class="sbox-ruleset-editor-wrap">' +
					'<div id="sbox-ruleset-editor" class="sbox-ruleset-editor"></div>' +
				'</div>' +
				'<div class="sbox-rulesets-example">' +
					'<div class="sbox-muted" style="margin-bottom:6px;">' + safeText(_('Example usage in config.yaml')) + '</div>' +
					'<pre>rule-providers:\n  your-list:\n    behavior: classical\n    type: file\n    format: text\n    path: ./lst/your-list.txt</pre>' +
				'</div>' +
				(data.whitelistMode ? '' +
					'<div class="sbox-rulesets-whitelist">' +
						'<div class="sbox-rulesets-whitelist-head">' + safeText(_('IP-CIDR List (fake-ip whitelist mode)')) + '</div>' +
						'<div class="sbox-muted" style="margin-bottom:8px;">' + safeText(_('One IPv4/CIDR per line. Save applies firewall update without restarting Mihomo.')) + '</div>' +
						'<div id="sbox-ruleset-whitelist-editor" class="sbox-ruleset-whitelist-editor"></div>' +
						'<div class="sbox-actions" style="margin-top:8px;">' +
							'<button id="sbox-ruleset-save-whitelist" type="button" class="cbi-button cbi-button-apply">' + safeText(_('Save IP-CIDR List')) + '</button>' +
						'</div>' +
					'</div>'
					: '') +
			'</section>' +
		'</div>';

	const listNode = body.querySelector('#sbox-rulesets-list');
	const currentNode = body.querySelector('#sbox-ruleset-current');
	const emptyNode = body.querySelector('#sbox-ruleset-empty');
	const editorWrap = body.querySelector('#sbox-ruleset-editor-wrap');
	const saveBtn = body.querySelector('#sbox-ruleset-save');
	const deleteBtn = body.querySelector('#sbox-ruleset-delete');
	const createBtn = body.querySelector('#sbox-ruleset-create');
	const createInput = body.querySelector('#sbox-ruleset-new-name');
	const saveWhitelistBtn = body.querySelector('#sbox-ruleset-save-whitelist');

	function ensureRulesetEditor() {
		if (rulesetMainEditor) return;
		rulesetMainEditor = ace.edit('sbox-ruleset-editor');
		rulesetMainEditor.session.setMode('ace/mode/text');
		rulesetMainEditor.setOptions({
			fontSize: '12px',
			showPrintMargin: false,
			wrap: true,
			highlightActiveLine: true
		});
		applyThemeToEditor(rulesetMainEditor);
	}

	function refreshToolbarState() {
		const hasCurrent = !!currentRuleset;
		if (currentNode) currentNode.textContent = hasCurrent ? ('./lst/' + currentRuleset) : _('No file selected');
		if (saveBtn) saveBtn.disabled = !hasCurrent;
		if (deleteBtn) deleteBtn.disabled = !hasCurrent;
		if (emptyNode) emptyNode.style.display = hasCurrent ? 'none' : '';
		if (editorWrap) editorWrap.style.display = hasCurrent ? '' : 'none';
	}

	function renderRulesetList() {
		if (!listNode) return;
		listNode.innerHTML = '';

		if (!rulesetNames.length) {
			listNode.innerHTML = '<div class="sbox-muted">' + safeText(_('No rulesets yet.')) + '</div>';
			return;
		}

		rulesetNames.forEach((name) => {
			const button = E('button', {
				'type': 'button',
				'class': 'sbox-ruleset-list-item' + (name === currentRuleset ? ' active' : '')
			}, name);

			button.addEventListener('click', async () => {
				currentRuleset = name;
				renderRulesetList();
				refreshToolbarState();
				ensureRulesetEditor();
				const content = rulesetCache[currentRuleset] != null
					? rulesetCache[currentRuleset]
					: await L.resolveDefault(fs.read(RULESET_PATH + currentRuleset), '');
				rulesetCache[currentRuleset] = content;
				rulesetMainEditor.setValue(String(content || ''), -1);
				rulesetMainEditor.clearSelection();
			});

			listNode.appendChild(button);
		});
	}

	const closeModal = showModal({
		title: _('Rulesets'),
		body: body,
		modalClass: 'sbox-modal-wide',
		buttons: [
			{
				label: _('Close'),
				className: 'cbi-button cbi-button-neutral'
			}
		],
		onClose: destroyRulesetEditors
	});

	refreshToolbarState();
	renderRulesetList();

	if (currentRuleset) {
		ensureRulesetEditor();
		rulesetMainEditor.setValue(String(rulesetCache[currentRuleset] || ''), -1);
		rulesetMainEditor.clearSelection();
	}

	if (createInput && createBtn) {
		const createAction = () => withButtons(createBtn, async () => {
			const normalized = normalizeRulesetName(createInput.value);
			if (!normalized) {
				throw new Error(_('Invalid name. Use letters, numbers, "_" or "-".'));
			}

			const filename = normalized + '.txt';
			if (filename === FAKEIP_WHITELIST_FILENAME) {
				throw new Error(_('This name is reserved.'));
			}
			if (rulesetNames.includes(filename)) {
				throw new Error(_('A ruleset with this name already exists.'));
			}

			await fs.write(RULESET_PATH + filename, '');
			rulesetNames.push(filename);
			rulesetNames.sort((a, b) => a.localeCompare(b));
			rulesetCache[filename] = '';
			currentRuleset = filename;
			createInput.value = '';

			renderRulesetList();
			refreshToolbarState();
			ensureRulesetEditor();
			rulesetMainEditor.setValue('', -1);
			rulesetMainEditor.clearSelection();
			notify('info', _('Ruleset "%s" created.').format(filename));
		}).catch((e) => {
			notify('error', e.message || _('Failed to create ruleset.'));
		});

		createBtn.addEventListener('click', createAction);
		createInput.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				createAction();
			}
		});
	}

	if (saveBtn) {
		saveBtn.addEventListener('click', () => withButtons(saveBtn, async () => {
			if (!currentRuleset || !rulesetMainEditor) return;
			const raw = String(rulesetMainEditor.getValue() || '').replace(/\r\n/g, '\n');
			const finalContent = raw.trim() ? raw.trimEnd() + '\n' : '';
			await fs.write(RULESET_PATH + currentRuleset, finalContent);
			rulesetCache[currentRuleset] = finalContent;
			notify('info', _('Ruleset "%s" saved.').format(currentRuleset));
		}).catch((e) => {
			notify('error', _('Failed to save ruleset: %s').format(e.message));
		}));
	}

	if (deleteBtn) {
		deleteBtn.addEventListener('click', () => {
			if (!currentRuleset) return;
			const deletingName = currentRuleset;

			showModal({
				title: _('Delete Ruleset'),
				body: _('Are you sure you want to delete "%s"?').format(deletingName),
				buttons: [
					{
						label: _('Delete'),
						className: 'cbi-button cbi-button-negative',
						onClick: async function(ctx) {
							await fs.remove(RULESET_PATH + deletingName);
							rulesetNames = rulesetNames.filter((name) => name !== deletingName);
							delete rulesetCache[deletingName];
							currentRuleset = rulesetNames[0] || '';
							renderRulesetList();
							refreshToolbarState();
							if (rulesetMainEditor) {
								rulesetMainEditor.setValue(currentRuleset ? String(rulesetCache[currentRuleset] || '') : '', -1);
								rulesetMainEditor.clearSelection();
							}
							notify('info', _('Ruleset "%s" deleted.').format(deletingName));
							ctx.closeModal();
						}
					},
					{
						label: _('Cancel'),
						className: 'cbi-button cbi-button-neutral'
					}
				]
			});
		});
	}

	if (data.whitelistMode && saveWhitelistBtn) {
		rulesetWhitelistEditor = ace.edit('sbox-ruleset-whitelist-editor');
		rulesetWhitelistEditor.session.setMode('ace/mode/text');
		rulesetWhitelistEditor.setOptions({
			fontSize: '12px',
			showPrintMargin: false,
			wrap: true,
			highlightActiveLine: true
		});
		rulesetWhitelistEditor.setValue(String(data.whitelistContent || ''), -1);
		rulesetWhitelistEditor.clearSelection();
		applyThemeToEditor(rulesetWhitelistEditor);

		saveWhitelistBtn.addEventListener('click', () => withButtons(saveWhitelistBtn, async () => {
			const raw = String(rulesetWhitelistEditor.getValue() || '').replace(/\r\n/g, '\n');
			const finalContent = raw.trim() ? raw.trimEnd() + '\n' : '';
			await fs.write(RULESET_PATH + FAKEIP_WHITELIST_FILENAME, finalContent);

			const update = await fs.exec('/opt/simo/bin/simo-rules', ['update-ip-whitelist']);
			if (update && update.code === 0) {
				notify('info', _('IP-CIDR list saved and firewall rules updated.'));
			} else {
				const errMsg = String(update?.stderr || update?.stdout || _('unknown error')).trim();
				notify('warning', _('IP-CIDR list saved, but firewall update failed: %s').format(errMsg));
			}
		}).catch((e) => {
			notify('error', _('Failed to save IP-CIDR list: %s').format(e.message));
		}));
	}

	return closeModal;
}

function modeLabel(mode) {
	if (mode === 'tun') return 'tun mode';
	if (mode === 'mixed') return 'mixed mode';
	return 'tproxy mode';
}

function buildSettingsSummary() {
	if (!appState.settings) return '';

	const s = appState.settings;
	const lines = [];

	if (s.mode === 'explicit') {
		lines.push(_('Mode: Explicit (proxy only selected interfaces)'));
		if (s.autoDetectLan && appState.detectedLan) lines.push(_('Auto LAN: %s').format(appState.detectedLan));
	} else {
		lines.push(_('Mode: Exclude (proxy all except selected interfaces)'));
		if (s.autoDetectWan && appState.detectedWan) lines.push(_('Auto WAN: %s').format(appState.detectedWan));
	}

	const manual = (s.mode === 'explicit' ? s.includedInterfaces : s.excludedInterfaces) || [];
	if (manual.length) {
		lines.push(_('Manual interfaces: %s').format(manual.join(', ')));
	}

	lines.push(_('Proxy mode: %s').format(s.proxyMode || appState.proxyMode || 'tproxy'));
	lines.push(_('Tun stack: %s').format(s.tunStack || 'system'));

	return lines.map((line) => '<div>' + safeText(line) + '</div>').join('');
}

function buildInterfaceListHtml() {
	const s = appState.settings || {};
	const selectedSet = new Set((appState.selectedInterfaces || []).concat(
		s.mode === 'explicit' && s.autoDetectLan && appState.detectedLan ? [appState.detectedLan] : [],
		s.mode === 'exclude' && s.autoDetectWan && appState.detectedWan ? [appState.detectedWan] : []
	));

	const autoInterface = s.mode === 'explicit'
		? (s.autoDetectLan ? appState.detectedLan : '')
		: (s.autoDetectWan ? appState.detectedWan : '');

	const groups = { wan: [], ethernet: [], wifi: [], vpn: [], virtual: [], other: [] };
	(appState.interfaces || []).forEach((iface) => {
		const cat = groups[iface.category] ? iface.category : 'other';
		groups[cat].push(iface);
	});

	const titles = {
		wan: _('WAN'),
		ethernet: _('Ethernet'),
		wifi: _('Wi-Fi'),
		vpn: _('VPN / Tunnel'),
		virtual: _('Virtual'),
		other: _('Other')
	};

	const order = ['wan', 'ethernet', 'wifi', 'vpn', 'virtual', 'other'];
	const chunks = [];

	order.forEach((cat) => {
		if (!groups[cat].length) return;

		const items = groups[cat].map((iface) => {
			const isChecked = selectedSet.has(iface.name);
			const isAuto = autoInterface && iface.name === autoInterface;

			return '' +
				'<label class="sbox-interface-item' + (isAuto ? ' sbox-interface-auto' : '') + '">' +
				'<input type="checkbox" class="sbox-interface-check" value="' + safeText(iface.name) + '"' + (isChecked ? ' checked' : '') + ' />' +
				'<span>' + safeText(iface.name) + (isAuto ? ' <em>(' + safeText(_('auto')) + ')</em>' : '') + '</span>' +
				'</label>';
		}).join('');

		chunks.push('' +
			'<div class="sbox-interface-group">' +
			'<div class="sbox-interface-group-title">' + safeText(titles[cat]) + '</div>' +
			'<div class="sbox-interface-grid">' + items + '</div>' +
			'</div>');
	});

	if (!chunks.length) {
		return '<div class="sbox-muted">' + safeText(_('No interfaces detected.')) + '</div>';
	}

	return chunks.join('');
}

function buildSettingsPaneHtml() {
	const s = appState.settings || {
		mode: 'exclude',
		proxyMode: appState.proxyMode || 'tproxy',
		tunStack: 'system',
		autoDetectLan: true,
		autoDetectWan: true,
		blockQuic: true,
		useTmpfsRules: true,
		enableHwid: false,
		hwidUserAgent: 'Simo',
		hwidDeviceOS: 'OpenWrt'
	};

	const currentProxyMode = appState.proxyMode || s.proxyMode || 'tproxy';
	const showTunStack = currentProxyMode === 'tun' || currentProxyMode === 'mixed';

	return '' +
		'<div id="sbox-settings-status" class="sbox-settings-status">' +
			buildSettingsSummary() +
		'</div>' +
		'<div class="sbox-settings-gap" aria-hidden="true"></div>' +
		'<div class="sbox-settings-grid">' +
			'<section class="sbox-settings-block">' +
				'<h4>' + safeText(_('Traffic Scope')) + '</h4>' +
				'<label class="sbox-radio-row">' +
					'<input type="radio" name="sbox-interface-mode" value="exclude"' + (s.mode !== 'explicit' ? ' checked' : '') + ' />' +
					'<span>' + safeText(_('Exclude mode: proxy all interfaces except selected ones')) + '</span>' +
				'</label>' +
					'<label class="sbox-radio-row">' +
						'<input type="radio" name="sbox-interface-mode" value="explicit"' + (s.mode === 'explicit' ? ' checked' : '') + ' />' +
						'<span>' + safeText(_('Explicit mode: proxy only selected interfaces')) + '</span>' +
					'</label>' +
				'</section>' +

				'<section class="sbox-settings-block">' +
					'<h4>' + safeText(_('Auto Detection')) + '</h4>' +
					'<label class="sbox-checkbox-row" id="sbox-auto-lan-row"' + (s.mode === 'explicit' ? '' : ' style="display:none"') + '>' +
					'<input type="checkbox" id="sbox-auto-lan"' + (s.autoDetectLan ? ' checked' : '') + ' />' +
					'<span>' + safeText(_('Auto detect LAN bridge')) + '</span>' +
				'</label>' +
				'<label class="sbox-checkbox-row" id="sbox-auto-wan-row"' + (s.mode !== 'explicit' ? '' : ' style="display:none"') + '>' +
					'<input type="checkbox" id="sbox-auto-wan"' + (s.autoDetectWan ? ' checked' : '') + ' />' +
					'<span>' + safeText(_('Auto detect WAN interface')) + '</span>' +
				'</label>' +
				'<div class="sbox-muted">' +
					safeText(_('Detected LAN: %s').format(appState.detectedLan || '-')) + '<br/>' +
					safeText(_('Detected WAN: %s').format(appState.detectedWan || '-')) +
				'</div>' +
			'</section>' +

			'<section class="sbox-settings-block sbox-settings-block-wide">' +
				'<h4>' + safeText(_('Interfaces')) + '</h4>' +
				'<div class="sbox-muted" style="margin-bottom:8px;">' +
					(s.mode === 'explicit'
						? safeText(_('Choose interfaces that should go through proxy.'))
						: safeText(_('Choose interfaces that should bypass proxy.'))
					) +
				'</div>' +
				buildInterfaceListHtml() +
				'</section>' +

				'<section class="sbox-settings-block sbox-settings-block-wide">' +
					'<h4>' + safeText(_('Additional')) + '</h4>' +
					'<div id="sbox-tun-stack-row" style="margin-bottom:10px;' + (showTunStack ? '' : 'display:none;') + '">' +
						'<label>' + safeText(_('Tun stack')) + '</label>' +
						'<select id="sbox-tun-stack" class="cbi-input-select sbox-select">' +
							'<option value="system"' + ((s.tunStack || 'system') === 'system' ? ' selected' : '') + '>system</option>' +
							'<option value="gvisor"' + ((s.tunStack || 'system') === 'gvisor' ? ' selected' : '') + '>gvisor</option>' +
							'<option value="mixed"' + ((s.tunStack || 'system') === 'mixed' ? ' selected' : '') + '>mixed</option>' +
						'</select>' +
					'</div>' +
					'<label class="sbox-checkbox-row">' +
						'<input type="checkbox" id="sbox-block-quic"' + (s.blockQuic ? ' checked' : '') + ' />' +
						'<span>' + safeText(_('Block QUIC (UDP/443)')) + '</span>' +
					'</label>' +
				'<label class="sbox-checkbox-row">' +
					'<input type="checkbox" id="sbox-tmpfs"' + (s.useTmpfsRules ? ' checked' : '') + ' />' +
					'<span>' + safeText(_('Store rules/providers on tmpfs')) + '</span>' +
				'</label>' +
				'<label class="sbox-checkbox-row">' +
					'<input type="checkbox" id="sbox-enable-hwid"' + (s.enableHwid ? ' checked' : '') + ' />' +
					'<span>' + safeText(_('Inject HWID headers into proxy-providers')) + '</span>' +
				'</label>' +
				'<div class="sbox-form-grid">' +
					'<div>' +
						'<label>' + safeText(_('User-Agent')) + '</label>' +
						'<input id="sbox-hwid-user-agent" class="cbi-input-text sbox-input" type="text" value="' + safeText(s.hwidUserAgent || 'Simo') + '" />' +
					'</div>' +
					'<div>' +
						'<label>' + safeText(_('Device OS')) + '</label>' +
						'<input id="sbox-hwid-device-os" class="cbi-input-text sbox-input" type="text" value="' + safeText(s.hwidDeviceOS || 'OpenWrt') + '" />' +
					'</div>' +
				'</div>' +
			'</section>' +
			'</div>' +

			'<div class="sbox-settings-save-wrap">' +
				'<button id="sbox-settings-save" type="button" class="cbi-button cbi-button-apply sbox-settings-save-btn">' + safeText(_('Save Settings')) + '</button>' +
			'</div>' +
		'';
}

function buildConfigOptionsHtml() {
	return (appState.configProfiles || CONFIG_PROFILES).map((item) =>
		'<option value="' + safeText(item.name) + '"' +
		(item.name === appState.selectedConfigName ? ' selected' : '') +
		'>' + safeText(_(item.label)) + '</option>'
	).join('');
}

function buildPageHtml() {
	const activeCore = getActiveCoreType();
	const selectedCore = normalizeKernelType((appState.kernelStatus && appState.kernelStatus.selectedCore) || activeCore);
	const coreStatus = getCoreRuntimeStatus(activeCore);
	const versionApp = safeText(appState.versions.app || _('unknown'));
	const versionKernel = safeText(
		coreStatus.installed
			? (coreStatus.version || appState.versions.core || _('Installed'))
			: _('Not installed')
	);

	return '' +
		'<div class="sbox-header">' +
			'Simo <span class="sbox-version-inline">' +
				'<strong id="sbox-app-version">' + versionApp + '</strong>' +
				'<span id="sbox-app-action" class="sbox-version-action-icon" role="button" tabindex="0" title="' + safeText(_('Install Simo')) + '" aria-label="' + safeText(_('Install Simo')) + '"></span>' +
			'</span>' +
			'<span class="sbox-header-dot">|</span>' +
			'<span id="sbox-core-label">' + safeText(getCoreDisplayName(activeCore)) + '</span> <span class="sbox-version-inline">' +
				'<strong id="sbox-kernel-version">' + versionKernel + '</strong>' +
				'<span id="sbox-kernel-action" class="sbox-version-action-icon" role="button" tabindex="0" title="' + safeText(_('Install Kernel')) + '" aria-label="' + safeText(_('Install Kernel')) + '"></span>' +
			'</span>' +
			'<span class="sbox-header-dot">|</span>' +
			'<span class="sbox-proxy-mode-inline">' + safeText(_('Core')) + '</span>' +
			'<select id="sbox-core-select" class="cbi-input-select sbox-mode-select">' +
				'<option value="mihomo"' + (selectedCore === 'mihomo' ? ' selected' : '') + '>mihomo</option>' +
				'<option value="sing-box"' + (selectedCore === 'sing-box' ? ' selected' : '') + '>sing-box</option>' +
			'</select>' +
			'<span class="sbox-header-dot">|</span>' +
			'<span class="sbox-proxy-mode-inline">' + safeText(_('Mode')) + '</span>' +
			'<select id="sbox-mode-select" class="cbi-input-select sbox-mode-select">' +
				'<option value="tproxy"' + (appState.proxyMode === 'tproxy' ? ' selected' : '') + '>tproxy</option>' +
				'<option value="tun"' + (appState.proxyMode === 'tun' ? ' selected' : '') + '>tun</option>' +
				'<option value="mixed"' + (appState.proxyMode === 'mixed' ? ' selected' : '') + '>mixed</option>' +
			'</select>' +
			'<button id="sbox-theme-toggle" type="button" class="cbi-button cbi-button-neutral sbox-header-button sbox-theme-toggle" title="' + safeText(_('Switch theme')) + '">o</button>' +
			'<button id="sbox-dashboard" type="button" class="cbi-button cbi-button-negative sbox-header-button">' + safeText(_('Dashboard')) + '</button>' +
		'</div>' +

		'<div class="sbox-card">' +
			'<div class="sbox-card-tabs">' +
				'<button type="button" class="sbox-tab sbox-tab-active" data-ctrl-tab="control">' + safeText(_('Control')) + '</button>' +
				'<button type="button" class="sbox-tab" data-ctrl-tab="settings">' + safeText(_('Settings')) + '</button>' +
			'</div>' +

				'<div id="sbox-pane-control">' +
					'<div class="sbox-row">' +
						'<span id="sbox-status" class="sbox-status sbox-status-off">' +
							'<span class="sbox-dot sbox-dot-off"></span>' +
							'<span id="sbox-status-label">' + safeText(_('Service stopped')) + '</span>' +
						'</span>' +
						'<button id="sbox-start-stop" type="button" class="cbi-button cbi-button-positive">' + safeText(_('Start')) + '</button>' +
						'<button id="sbox-restart" type="button" class="cbi-button cbi-button-apply">' + safeText(_('Restart')) + '</button>' +
					'</div>' +
				'</div>' +

			'<div id="sbox-pane-settings" style="display:none"></div>' +
		'</div>' +

		'<div class="sbox-card">' +
			'<div class="sbox-card-tabs">' +
				'<button type="button" class="sbox-tab sbox-tab-active" data-cfg-tab="config">' + safeText(_('Config')) + '</button>' +
				'<button type="button" class="sbox-tab" data-cfg-tab="logs">' + safeText(_('Logs')) + '</button>' +
			'</div>' +

				'<div id="sbox-pane-config">' +
					'<div class="sbox-config-toolbar">' +
						'<select id="sbox-config-select" class="cbi-input-select sbox-select">' + buildConfigOptionsHtml() + '</select>' +
						'<input id="sbox-subscription-url" class="cbi-input-text sbox-input" type="text" placeholder="https://..." value="' + safeText(appState.subscriptionUrl || '') + '" />' +
						'<button id="sbox-save-update-sub" type="button" class="cbi-button cbi-button-positive sbox-save-update-sub">' + safeText(_('Save URL / Update Config')) + '</button>' +
					'</div>' +
				'<div id="simo-editor" class="sbox-editor"></div>' +
				'<div class="sbox-actions">' +
						'<button id="sbox-validate" type="button" class="cbi-button cbi-button-apply">' + safeText(_('Validate YAML')) + '</button>' +
						'<button id="sbox-save" type="button" class="cbi-button cbi-button-positive">' + safeText(_('Save')) + '</button>' +
						'<button id="sbox-clear-editor" type="button" class="cbi-button cbi-button-negative">' + safeText(_('Clear Editor')) + '</button>' +
						'<button id="sbox-set-main-config" type="button" class="cbi-button cbi-button-apply sbox-action-right"' +
							(appState.selectedConfigName === MAIN_CONFIG_NAME ? ' style="display:none"' : '') +
						'>' + safeText(_('Set as Main')) + '</button>' +
					'</div>' +
					'<div class="sbox-config-footer">' +
						'<button id="sbox-open-rulesets" type="button" class="cbi-button cbi-button-neutral">' + safeText(_('Rulesets')) + '</button>' +
					'</div>' +
				'</div>' +

			'<div id="sbox-pane-logs" style="display:none">' +
				'<div class="sbox-log-toolbar">' +
					'<button id="sbox-log-refresh" type="button" class="cbi-button cbi-button-apply">' + safeText(_('Refresh')) + '</button>' +
					'<span id="sbox-log-updated" class="sbox-log-updated"></span>' +
				'</div>' +
				'<pre id="sbox-log-content" class="sbox-log-content"></pre>' +
			'</div>' +
		'</div>';
}

function updateHeaderAndControlDom() {
	if (!pageRoot) return;

	const status = pageRoot.querySelector('#sbox-status');
	const statusLabel = pageRoot.querySelector('#sbox-status-label');
	const dot = pageRoot.querySelector('#sbox-status .sbox-dot');
	const startStop = pageRoot.querySelector('#sbox-start-stop');
	const restartBtn = pageRoot.querySelector('#sbox-restart');
	const dashboardBtn = pageRoot.querySelector('#sbox-dashboard');
	const appVersion = pageRoot.querySelector('#sbox-app-version');
	const appAction = pageRoot.querySelector('#sbox-app-action');
	const coreLabel = pageRoot.querySelector('#sbox-core-label');
	const coreSelect = pageRoot.querySelector('#sbox-core-select');
	const kernelVersion = pageRoot.querySelector('#sbox-kernel-version');
	const kernelAction = pageRoot.querySelector('#sbox-kernel-action');
	const modeSelect = pageRoot.querySelector('#sbox-mode-select');
	const activeCore = getActiveCoreType();
	const selectedCore = normalizeKernelType((appState.kernelStatus && appState.kernelStatus.selectedCore) || activeCore);
	const coreStatus = getCoreRuntimeStatus(activeCore);

	if (status && statusLabel && dot) {
		status.classList.toggle('sbox-status-on', appState.serviceRunning);
		status.classList.toggle('sbox-status-off', !appState.serviceRunning);
		dot.classList.toggle('sbox-dot-on', appState.serviceRunning);
		dot.classList.toggle('sbox-dot-off', !appState.serviceRunning);
		statusLabel.textContent = appState.serviceRunning ? _('Service running') : _('Service stopped');
	}

	if (startStop) {
		startStop.textContent = appState.serviceRunning ? _('Stop') : _('Start');
		startStop.className = 'cbi-button ' + (appState.serviceRunning ? 'cbi-button-negative' : 'cbi-button-positive');
	}

	if (restartBtn) {
		restartBtn.style.display = appState.serviceRunning ? '' : 'none';
		restartBtn.disabled = !appState.serviceRunning;
	}

	if (dashboardBtn) {
		dashboardBtn.disabled = !appState.serviceRunning;
		dashboardBtn.className = 'cbi-button cbi-button-negative sbox-header-button';
	}

	if (appVersion) appVersion.textContent = appState.versions.app || _('unknown');
	if (coreLabel) coreLabel.textContent = getCoreDisplayName(activeCore);
	if (coreSelect) coreSelect.value = selectedCore;
	if (appAction && !appAction.classList.contains('sbox-version-action-busy')) {
		const appActionState = resolveAppActionState();
		appAction.classList.remove('sbox-version-action-install', 'sbox-version-action-reinstall');
		appAction.classList.add(appActionState.className);
		appAction.textContent = appActionState.icon;
		appAction.title = appActionState.title;
		appAction.setAttribute('aria-label', appActionState.title);
	}
	if (kernelVersion) {
		kernelVersion.textContent = coreStatus.installed
			? (coreStatus.version || appState.versions.core || _('Installed'))
			: _('Not installed');
	}
	if (kernelAction && !kernelAction.classList.contains('sbox-version-action-busy')) {
		const kernelActionState = resolveKernelActionState();
		kernelAction.classList.remove('sbox-version-action-install', 'sbox-version-action-reinstall');
		kernelAction.classList.add(kernelActionState.className);
		kernelAction.textContent = kernelActionState.icon;
		kernelAction.title = kernelActionState.title;
		kernelAction.setAttribute('aria-label', kernelActionState.title);
	}
	if (modeSelect) modeSelect.value = normalizeProxyMode(appState.proxyMode);
}

async function refreshHeaderAndControl() {
	const [running, versions, kernelStatus, proxyMode] = await Promise.all([
		getServiceStatus(),
		getVersions(),
		getKernelStatus(),
		detectCurrentProxyMode()
	]);

	appState.serviceRunning = !!running;
	appState.versions = versions;
	appState.kernelStatus = kernelStatus;
	if (kernelStatus && kernelStatus.version) {
		appState.versions.core = kernelStatus.version;
	}
	appState.proxyMode = proxyMode || 'tproxy';

	updateHeaderAndControlDom();
}

function renderSettingsPane() {
	if (!pageRoot) return;
	const pane = pageRoot.querySelector('#sbox-pane-settings');
	if (!pane) return;

	pane.innerHTML = buildSettingsPaneHtml();
	bindSettingsPaneEvents();
}

async function collectSettingsFormState() {
	const pane = pageRoot.querySelector('#sbox-pane-settings');
	if (!pane) return null;

	const mode = pane.querySelector('input[name="sbox-interface-mode"]:checked')?.value || 'exclude';
	const proxyMode = normalizeProxyMode(appState.proxyMode || 'tproxy');
	const tunStack = pane.querySelector('#sbox-tun-stack')?.value || 'system';
	const autoDetectLan = !!pane.querySelector('#sbox-auto-lan')?.checked;
	const autoDetectWan = !!pane.querySelector('#sbox-auto-wan')?.checked;
	const blockQuic = !!pane.querySelector('#sbox-block-quic')?.checked;
	const useTmpfsRules = !!pane.querySelector('#sbox-tmpfs')?.checked;
	const enableHwid = !!pane.querySelector('#sbox-enable-hwid')?.checked;
	const hwidUserAgent = String(pane.querySelector('#sbox-hwid-user-agent')?.value || 'Simo').trim() || 'Simo';
	const hwidDeviceOS = String(pane.querySelector('#sbox-hwid-device-os')?.value || 'OpenWrt').trim() || 'OpenWrt';

	const selected = [];
	pane.querySelectorAll('.sbox-interface-check:checked').forEach((cb) => {
		selected.push(cb.value);
	});

	return {
		mode,
		proxyMode,
		tunStack,
		autoDetectLan,
		autoDetectWan,
		blockQuic,
		useTmpfsRules,
		selected,
		enableHwid,
		hwidUserAgent,
		hwidDeviceOS
	};
}

function bindSettingsPaneEvents() {
	const pane = pageRoot.querySelector('#sbox-pane-settings');
	if (!pane) return;

	pane.querySelectorAll('input[name="sbox-interface-mode"]').forEach((radio) => {
		radio.addEventListener('change', async function() {
			appState.settings.mode = this.value;
			appState.selectedInterfaces = await loadInterfacesByMode(this.value);
			renderSettingsPane();
		});
	});

	const saveBtn = pane.querySelector('#sbox-settings-save');
	if (saveBtn) {
		saveBtn.addEventListener('click', () => withButtons(saveBtn, async () => {
			const formState = await collectSettingsFormState();
			if (!formState) return;

			const ok = await saveOperationalSettings(
				formState.mode,
				formState.proxyMode,
				formState.tunStack,
				formState.autoDetectLan,
				formState.autoDetectWan,
				formState.blockQuic,
					formState.useTmpfsRules,
					formState.selected,
					formState.enableHwid,
					formState.hwidUserAgent,
					formState.hwidDeviceOS,
					{ silent: true }
				);

				if (!ok) return;
				try {
					await execService('restart');
					notify('info', _('Settings saved and Simo service restarted.'));
				} catch (e) {
					notify('error', _('Settings saved, but failed to restart Simo service: %s').format(e.message));
				}

				appState.settings = await loadOperationalSettings();
				appState.selectedInterfaces = await loadInterfacesByMode(appState.settings.mode);
				appState.detectedLan = appState.settings.detectedLan || (await detectLanBridge()) || '';
				appState.detectedWan = appState.settings.detectedWan || (await detectWanInterface()) || '';
				appState.proxyMode = appState.settings.proxyMode || await detectCurrentProxyMode();
				appState.serviceRunning = await getServiceStatus();

				const freshConfig = await L.resolveDefault(
					fs.read(getConfigPathByName(appState.selectedConfigName)),
					''
				);
				appState.configContent = freshConfig;
				if (editor) {
					editor.setValue(String(freshConfig || ''), -1);
					editor.clearSelection();
				}

				await refreshHeaderAndControl();
				renderSettingsPane();
				updateHeaderAndControlDom();
			}).catch((e) => {
				notify('error', _('Failed to save settings: %s').format(e.message));
			}));
	}
}

async function refreshLogs() {
	const raw = await loadServiceLogs();
	appState.logsRaw = raw;
	appState.logsUpdatedAt = Date.now();

	const content = pageRoot && pageRoot.querySelector('#sbox-log-content');
	const updated = pageRoot && pageRoot.querySelector('#sbox-log-updated');

	if (content) content.innerHTML = colorizeLog(raw);
	if (updated) {
		const text = appState.logsUpdatedAt
			? new Date(appState.logsUpdatedAt).toLocaleString()
			: '-';
		updated.textContent = _('Updated: %s').format(text);
	}
}

function startLogPolling() {
	if (logPollTimer) return;
	logPollTimer = setInterval(() => {
		if (appState.activeCfgTab === 'logs') refreshLogs().catch(() => {});
	}, LOG_POLL_MS);
}

function stopLogPolling() {
	if (logPollTimer) {
		clearInterval(logPollTimer);
		logPollTimer = null;
	}
}

function startControlPolling() {
	if (controlPollTimer) clearInterval(controlPollTimer);

	controlPollTimer = setInterval(async () => {
		try {
			appState.serviceRunning = await getServiceStatus();
			updateHeaderAndControlDom();
		} catch (e) {}
	}, STATUS_POLL_MS);
}

function startUpdatePolling() {
	if (updatePollTimer) clearInterval(updatePollTimer);

	updatePollTimer = setInterval(() => {
		if (document.hidden) return;
		refreshReleaseMeta({ force: false }).catch(() => {});
	}, UPDATE_CHECK_MS);
}

function bindControlAndHeaderEvents() {
	const themeBtn = pageRoot.querySelector('#sbox-theme-toggle');
	if (themeBtn) {
		themeBtn.addEventListener('click', () => {
			const nextTheme = appState.uiTheme === 'dark' ? 'light' : 'dark';
			applyUiTheme(nextTheme);
			saveThemePreference(nextTheme).catch((e) => {
				notify('error', _('Failed to save theme preference: %s').format(e.message));
			});
		});
	}

	const kernelAction = pageRoot.querySelector('#sbox-kernel-action');
	const appAction = pageRoot.querySelector('#sbox-app-action');
	if (appAction) {
		const runAppAction = () => {
			if (appAction.classList.contains('sbox-version-action-busy')) return;
			const appActionKind = resolveAppActionState().kind;

			appAction.classList.add('sbox-version-action-busy');
			appAction.innerHTML = '<span class="sbox-spinner"></span>';

			installSimoFromSettings(appActionKind).catch((e) => {
				notify('error', _('Failed to update Simo: %s').format(e.message));
			}).finally(async () => {
				if (appAction && appAction.isConnected) {
					appAction.classList.remove('sbox-version-action-busy');
					try {
						await refreshHeaderAndControl();
					} catch (refreshError) {}
					updateHeaderAndControlDom();
				}
			});
		};

		appAction.addEventListener('click', runAppAction);
		appAction.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' || ev.key === ' ') {
				ev.preventDefault();
				runAppAction();
			}
		});
	}

	if (kernelAction) {
		const runKernelAction = () => {
			if (kernelAction.classList.contains('sbox-version-action-busy')) return;

			kernelAction.classList.add('sbox-version-action-busy');
			kernelAction.innerHTML = '<span class="sbox-spinner"></span>';

			installKernelFromSettings().then(() => {
				renderSettingsPane();
			}).catch((e) => {
				notify('error', _('Failed to load kernel information: %s').format(e.message));
			}).finally(() => {
				if (kernelAction && kernelAction.isConnected) {
					kernelAction.classList.remove('sbox-version-action-busy');
					updateHeaderAndControlDom();
				}
			});
		};

		kernelAction.addEventListener('click', runKernelAction);
		kernelAction.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' || ev.key === ' ') {
				ev.preventDefault();
				runKernelAction();
			}
		});
	}

	const coreSelect = pageRoot.querySelector('#sbox-core-select');
	if (coreSelect) {
		coreSelect.addEventListener('change', async function() {
			const select = this;
			const previousCore = normalizeKernelType((appState.kernelStatus && appState.kernelStatus.selectedCore) || 'mihomo');
			const nextCore = normalizeKernelType(select.value);
			if (nextCore === previousCore) return;
			const serviceWasRunning = !!appState.serviceRunning;
			let switched = false;

			select.disabled = true;
			try {
				await setActiveKernel(nextCore);
				await syncActiveCoreLink(nextCore);
				switched = true;
				appState.kernelStatus = await getKernelStatus();
				appState.versions.core = appState.kernelStatus.version || appState.versions.core;

				const nextStatus = getCoreRuntimeStatus(nextCore);
				if (!nextStatus.installed) {
					notify('info', _('Core switched to %s. Install its kernel binary to use it.').format(getCoreDisplayName(nextCore)));
				} else {
					await migrateCoreRuntime(nextCore);
					await validateCoreRuntime(nextCore);

					if (serviceWasRunning) {
						await execServiceOrThrow('restart');
						const healthy = await waitForRuntimeHealthy(nextCore, 15000, 1000);
						if (!healthy) {
							throw new Error(_('Service did not become healthy after restart.'));
						}
						notify('info', _('Kernel switched to %s, config validated, and service is healthy.').format(getCoreDisplayName(nextCore)));
					} else {
						notify('info', _('Kernel switched to %s. Runtime config prepared and validated.').format(getCoreDisplayName(nextCore)));
					}
				}
			} catch (e) {
				select.value = previousCore;
				if (switched) {
					try {
						await setActiveKernel(previousCore);
						await syncActiveCoreLink(previousCore);
						appState.kernelStatus = await getKernelStatus();
						appState.versions.core = appState.kernelStatus.version || appState.versions.core;

						const previousStatus = getCoreRuntimeStatus(previousCore);
						if (previousStatus.installed) {
							await L.resolveDefault(migrateCoreRuntime(previousCore), null);
							await L.resolveDefault(validateCoreRuntime(previousCore), null);

							if (serviceWasRunning) {
								await execServiceOrThrow('restart');
								await waitForRuntimeHealthy(previousCore, 15000, 1000);
							}
						}

						notify(
							'error',
							_('Kernel switch to %s failed: %s. Rolled back to %s.')
								.format(getCoreDisplayName(nextCore), e.message, getCoreDisplayName(previousCore))
						);
					} catch (rollbackErr) {
						notify(
							'error',
							_('Kernel switch to %s failed, and rollback to %s also failed: %s')
								.format(getCoreDisplayName(nextCore), getCoreDisplayName(previousCore), rollbackErr.message)
						);
					}
				} else {
					notify('error', _('Failed to switch kernel: %s').format(e.message));
				}
			} finally {
				await refreshReleaseMeta({ force: true }).catch(() => {});
				await refreshHeaderAndControl().catch(() => {});
				updateHeaderAndControlDom();
				if (select && select.isConnected) select.disabled = false;
			}
		});
	}

	const modeSelect = pageRoot.querySelector('#sbox-mode-select');
	if (modeSelect) {
		modeSelect.addEventListener('change', async function() {
			const select = this;
			const previousMode = normalizeProxyMode(appState.proxyMode);
			const nextMode = normalizeProxyMode(select.value);
			if (nextMode === previousMode) return;

			select.disabled = true;
			try {
				await switchProxyModeFromHeader(nextMode);
			} catch (e) {
				appState.proxyMode = previousMode;
				updateHeaderAndControlDom();
				notify('error', _('Failed to switch proxy mode: %s').format(e.message));
			} finally {
				if (select && select.isConnected) select.disabled = false;
			}
		});
	}

	const startStop = pageRoot.querySelector('#sbox-start-stop');
	if (startStop) {
		startStop.addEventListener('click', () => withButtons(startStop, async () => {
			const running = await getServiceStatus();
			if (running) {
				await execService('stop');
				await execService('disable');
			} else {
				await execService('enable');
				await execService('start');
			}
			appState.serviceRunning = await getServiceStatus();
			updateHeaderAndControlDom();
		}).catch((e) => {
			notify('error', _('Unable to toggle service: %s').format(e.message));
		}));
	}

	const restartBtn = pageRoot.querySelector('#sbox-restart');
	if (restartBtn) {
		restartBtn.addEventListener('click', () => withButtons(restartBtn, async () => {
			await execService('restart');
			notify('info', _('Simo service restarted successfully.'));
			await refreshHeaderAndControl();
		}).catch((e) => {
			notify('error', _('Failed to restart Simo service: %s').format(e.message));
		}));
	}

	const dashboardBtn = pageRoot.querySelector('#sbox-dashboard');
	if (dashboardBtn) {
		dashboardBtn.addEventListener('click', () => {
			if (dashboardBtn.disabled) return;
			openDashboard().catch((e) => {
			notify('error', _('Failed to open dashboard: %s').format(e.message));
			});
		});
	}
}

async function switchConfigProfile(profileName) {
	const selected = normalizeConfigProfileName(profileName);
	const [content, url] = await Promise.all([
		readConfigFileByName(selected),
		readSubscriptionUrl(selected)
	]);

	appState.selectedConfigName = selected;
	appState.configContent = String(content || '');
	appState.subscriptionUrl = String(url || '');

	if (editor) {
		editor.setValue(appState.configContent, -1);
		editor.clearSelection();
	}

	if (pageRoot) {
		const selectEl = pageRoot.querySelector('#sbox-config-select');
		const urlEl = pageRoot.querySelector('#sbox-subscription-url');
		const setMainBtn = pageRoot.querySelector('#sbox-set-main-config');
		if (selectEl) selectEl.value = selected;
		if (urlEl) urlEl.value = appState.subscriptionUrl;
		if (setMainBtn) setMainBtn.style.display = selected === MAIN_CONFIG_NAME ? 'none' : '';
	}
}

async function setSelectedConfigAsMain() {
	const selected = normalizeConfigProfileName(appState.selectedConfigName);
	if (selected === MAIN_CONFIG_NAME) return;

	const [mainContent, selectedContent, mainUrl, selectedUrl] = await Promise.all([
		readConfigFileByName(MAIN_CONFIG_NAME),
		readConfigFileByName(selected),
		readSubscriptionUrl(MAIN_CONFIG_NAME),
		readSubscriptionUrl(selected)
	]);

	await writeConfigFileByName(MAIN_CONFIG_NAME, selectedContent);
	await writeConfigFileByName(selected, mainContent);
	await saveSubscriptionUrl(selectedUrl, MAIN_CONFIG_NAME);
	await saveSubscriptionUrl(mainUrl, selected);

	await execService('restart');
	appState.serviceRunning = await getServiceStatus();
	await switchConfigProfile(MAIN_CONFIG_NAME);
	await refreshHeaderAndControl();

	notify('info', _('%s is now main config.').format(_(getConfigLabel(selected))));
}

function bindConfigEvents() {
	const subInput = pageRoot.querySelector('#sbox-subscription-url');
	const configSelect = pageRoot.querySelector('#sbox-config-select');
	const setMainBtn = pageRoot.querySelector('#sbox-set-main-config');

	if (configSelect) {
		configSelect.addEventListener('change', async function() {
			const nextConfig = normalizeConfigProfileName(this.value);
			this.disabled = true;
			try {
				await switchConfigProfile(nextConfig);
			} catch (e) {
				notify('error', _('Failed to load config profile: %s').format(e.message));
			} finally {
				if (this.isConnected) this.disabled = false;
			}
		});
	}

	if (setMainBtn) {
		setMainBtn.addEventListener('click', () => withButtons(setMainBtn, async () => {
			const selected = normalizeConfigProfileName(appState.selectedConfigName);
			if (selected === MAIN_CONFIG_NAME) return;

			showModal({
				title: _('Set as Main'),
				body: _('Selected config will be swapped with Main config, saved, and service will restart. Continue?'),
				buttons: [
					{
						label: _('Set as Main'),
						className: 'cbi-button cbi-button-apply',
						onClick: async function(ctx) {
							await setSelectedConfigAsMain();
							ctx.closeModal();
						}
					},
					{
						label: _('Cancel'),
						className: 'cbi-button cbi-button-neutral'
					}
				]
			});
		}).catch((e) => {
			notify('error', _('Failed to set main config: %s').format(e.message));
		}));
	}

	const saveUpdateBtn = pageRoot.querySelector('#sbox-save-update-sub');
	if (saveUpdateBtn) {
		saveUpdateBtn.addEventListener('click', () => withButtons(saveUpdateBtn, async () => {
				const url = String(subInput?.value || '').trim();
				if (!url) throw new Error(_('Subscription URL is empty.'));
				if (!isValidUrl(url)) throw new Error(_('Invalid subscription URL.'));

				const selectedConfig = normalizeConfigProfileName(appState.selectedConfigName);
				const selectedPath = getConfigPathByName(selectedConfig);
				await saveSubscriptionUrl(url, selectedConfig);
				appState.subscriptionUrl = url;

				const downloadedInfo = await fetchSubscriptionAsYaml(url, selectedPath);
				const downloaded = String(downloadedInfo.content || '').trimEnd() + '\n';

				const tested = await testConfigContent(downloaded, true, selectedPath);
				if (!tested.ok) throw new Error(_('YAML validation failed: %s').format(tested.message));

				appState.configContent = downloaded;
				if (editor) {
					editor.setValue(downloaded, -1);
					editor.clearSelection();
				}

				if (selectedConfig === MAIN_CONFIG_NAME) {
					await execService('reload');
					appState.serviceRunning = await getServiceStatus();
					updateHeaderAndControlDom();
				}

				if (downloadedInfo.mode === 'remnawave-client-path') {
					notify('info', _('Subscription downloaded and applied (Remnawave /mihomo fallback).'));
				} else if (selectedConfig === MAIN_CONFIG_NAME) {
					notify('info', _('Subscription downloaded and applied.'));
				} else {
					notify('info', _('%s downloaded and saved.').format(_(getConfigLabel(selectedConfig))));
				}
			}).catch((e) => {
				notify('error', _('Failed to apply subscription: %s').format(e.message));
			}).finally(async () => {
				try { await fs.remove(TMP_SUBSCRIPTION_PATH); } catch (removeErr) {}
			})
		);
	}

	const validateBtn = pageRoot.querySelector('#sbox-validate');
	if (validateBtn) {
		validateBtn.addEventListener('click', () => withButtons(validateBtn, async () => {
			if (!editor) return;
			const tested = await testConfigContent(
				editor.getValue(),
				false,
				getConfigPathByName(appState.selectedConfigName)
			);
			if (!tested.ok) throw new Error(tested.message);
			notify('info', _('YAML validation passed.'));
		}).catch((e) => {
			notify('error', _('YAML validation failed: %s').format(e.message));
		}));
	}

	const saveBtn = pageRoot.querySelector('#sbox-save');
	if (saveBtn) {
		saveBtn.addEventListener('click', () => withButtons(saveBtn, async () => {
			if (!editor) return;
			const selectedConfig = normalizeConfigProfileName(appState.selectedConfigName);
			const selectedPath = getConfigPathByName(selectedConfig);
			const tested = await testConfigContent(editor.getValue(), true, selectedPath);
			if (!tested.ok) throw new Error(tested.message);
			appState.configContent = editor.getValue();

			if (selectedConfig === MAIN_CONFIG_NAME) {
				await execService('reload');
				appState.serviceRunning = await getServiceStatus();
				updateHeaderAndControlDom();
				notify('info', _('Configuration applied and service reloaded.'));
			} else {
				notify('info', _('%s saved.').format(_(getConfigLabel(selectedConfig))));
			}
		}).catch((e) => {
			notify('error', _('Failed to apply configuration: %s').format(e.message));
		}));
	}

	const clearBtn = pageRoot.querySelector('#sbox-clear-editor');
	if (clearBtn) {
		clearBtn.addEventListener('click', () => {
			showModal({
				title: _('Clear editor?'),
				body: _('This will clear only editor content. File is not modified until you click Save.'),
				buttons: [
					{
						label: _('Clear'),
						className: 'cbi-button cbi-button-negative',
						onClick: async function(ctx) {
							if (editor) {
								editor.setValue('', -1);
								editor.clearSelection();
							}
							ctx.closeModal();
						}
					},
					{
						label: _('Cancel'),
						className: 'cbi-button cbi-button-neutral'
					}
				]
			});
		});
	}

	const rulesetsBtn = pageRoot.querySelector('#sbox-open-rulesets');
	if (rulesetsBtn) {
		rulesetsBtn.addEventListener('click', () => withButtons(rulesetsBtn, async () => {
			await openRulesetsModal();
		}).catch((e) => {
			notify('error', _('Failed to open rulesets: %s').format(e.message));
		}));
	}

	const logRefreshBtn = pageRoot.querySelector('#sbox-log-refresh');
	if (logRefreshBtn) {
		logRefreshBtn.addEventListener('click', () => withButtons(logRefreshBtn, async () => {
			await refreshLogs();
		}).catch((e) => {
			notify('error', _('Failed to refresh logs: %s').format(e.message));
		}));
	}
}

function bindTabEvents() {
	const ctrlTabs = Array.from(pageRoot.querySelectorAll('[data-ctrl-tab]'));
	const cfgTabs = Array.from(pageRoot.querySelectorAll('[data-cfg-tab]'));

	const paneControl = pageRoot.querySelector('#sbox-pane-control');
	const paneSettings = pageRoot.querySelector('#sbox-pane-settings');
	const paneConfig = pageRoot.querySelector('#sbox-pane-config');
	const paneLogs = pageRoot.querySelector('#sbox-pane-logs');

	const setCtrlTab = (name) => {
		appState.activeCtrlTab = name;
		ctrlTabs.forEach((tab) => tab.classList.toggle('sbox-tab-active', tab.dataset.ctrlTab === name));
		paneControl.style.display = name === 'control' ? '' : 'none';
		paneSettings.style.display = name === 'settings' ? '' : 'none';
		if (name === 'settings') renderSettingsPane();
	};

	const setCfgTab = (name) => {
		appState.activeCfgTab = name;
		cfgTabs.forEach((tab) => tab.classList.toggle('sbox-tab-active', tab.dataset.cfgTab === name));
		paneConfig.style.display = name === 'config' ? '' : 'none';
		paneLogs.style.display = name === 'logs' ? '' : 'none';

		if (name === 'logs') {
			refreshLogs().catch(() => {});
			startLogPolling();
		} else {
			stopLogPolling();
		}
	};

	ctrlTabs.forEach((tab) => {
		tab.addEventListener('click', () => setCtrlTab(tab.dataset.ctrlTab));
	});

	cfgTabs.forEach((tab) => {
		tab.addEventListener('click', () => setCfgTab(tab.dataset.cfgTab));
	});

	setCtrlTab(appState.activeCtrlTab || 'control');
	setCfgTab(appState.activeCfgTab || 'config');
}

const PAGE_CSS = `
#tabmenu, .cbi-tabmenu { display: none !important; }
.sbox-page {
	--sbox-bg: linear-gradient(180deg, #111214 0%, #0f1012 100%);
	--sbox-card: #17191d;
	--sbox-border: #2a2d33;
	--sbox-text: #e3e6eb;
	--sbox-muted: #8f97a3;
	--sbox-accent: #5c7088;
	--sbox-success: #2ecc71;
	--sbox-danger: #f85149;
	--sbox-warn: #d29922;
	--sbox-log-bg: #0b0c0f;
	--sbox-panel-bg: rgba(255, 255, 255, 0.02);
	--sbox-modal-bg: #171a1f;
	color: var(--sbox-text);
}
.sbox-page.sbox-theme-light {
	--sbox-bg: linear-gradient(180deg, #f5f7fb 0%, #eef2f8 100%);
	--sbox-card: #ffffff;
	--sbox-border: #d8deea;
	--sbox-text: #1d2634;
	--sbox-muted: #5f6f86;
	--sbox-accent: #2a78ff;
	--sbox-success: #1f9c57;
	--sbox-danger: #cc3b34;
	--sbox-warn: #b8801d;
	--sbox-log-bg: #f7f9fc;
	--sbox-panel-bg: #f8fbff;
	--sbox-modal-bg: #ffffff;
}
.sbox-page.sbox-theme-light .sbox-log-muted { color: #4f627a; }
.sbox-page.sbox-theme-light .sbox-log-info { color: #1f9c57; }
.sbox-page.sbox-theme-light .sbox-log-warn { color: #b8801d; }
.sbox-page.sbox-theme-light .sbox-log-error { color: #cc3b34; }
.sbox-page .main {
	background: var(--sbox-bg);
}
.sbox-header {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-wrap: wrap;
	gap: 8px;
	margin-bottom: 12px;
	font-size: 13px;
	color: var(--sbox-muted);
}
.sbox-header strong {
	color: var(--sbox-text);
	font-weight: 700;
}
.sbox-version-inline {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}
.sbox-version-action-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 16px;
	font-size: 14px;
	line-height: 1;
	cursor: pointer;
	user-select: none;
	opacity: 0.95;
	transition: transform 0.16s ease, opacity 0.16s ease;
}
.sbox-version-action-icon:hover,
.sbox-version-action-icon:focus {
	transform: scale(1.08);
	opacity: 1;
	outline: none;
}
.sbox-version-action-install { color: #29a55a; }
.sbox-version-action-reinstall { color: #2a78ff; }
.sbox-version-action-busy {
	pointer-events: none;
}
.sbox-header-dot {
	opacity: 0.55;
}
.sbox-header-button {
	font-size: 11px;
	padding: 2px 8px;
	min-height: 24px;
}
.sbox-btn-validate,
.sbox-btn-restart,
.sbox-btn-dashboard-on {
	background: var(--sbox-accent) !important;
	border-color: var(--sbox-accent) !important;
	color: #fff !important;
}
.sbox-btn-start {
	background: var(--sbox-success) !important;
	border-color: var(--sbox-success) !important;
	color: #fff !important;
}
.sbox-btn-stop,
.sbox-btn-dashboard-off {
	background: var(--sbox-danger) !important;
	border-color: var(--sbox-danger) !important;
	color: #fff !important;
}
.sbox-btn-dashboard:disabled {
	cursor: not-allowed;
	opacity: 0.8;
}
.sbox-theme-toggle {
	width: 24px;
	min-width: 24px;
	padding: 0;
	font-size: 12px;
	line-height: 1;
}
.sbox-card {
	background: var(--sbox-card);
	border: 1px solid var(--sbox-border);
	border-radius: 10px;
	padding: 14px;
	margin-bottom: 10px;
}
.sbox-card-tabs {
	display: flex;
	gap: 2px;
	border-bottom: 1px solid var(--sbox-border);
	margin-bottom: 12px;
}
.sbox-tab {
	appearance: none;
	border: none;
	background: transparent;
	color: var(--sbox-muted);
	text-transform: uppercase;
	letter-spacing: 0.08em;
	font-size: 11px;
	font-weight: 700;
	padding: 6px 10px;
	border-bottom: 2px solid transparent;
	cursor: pointer;
}
.sbox-tab:hover { color: var(--sbox-text); }
.sbox-tab-active {
	color: var(--sbox-text);
	border-bottom-color: var(--sbox-accent);
}
.sbox-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}
.sbox-status {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 4px 10px;
	border-radius: 999px;
	border: 1px solid transparent;
	font-size: 12px;
	font-weight: 700;
}
.sbox-status-on {
	background: rgba(46, 204, 113, 0.12);
	border-color: rgba(46, 204, 113, 0.4);
	color: #63d996;
}
.sbox-status-off {
	background: rgba(248, 81, 73, 0.12);
	border-color: rgba(248, 81, 73, 0.35);
	color: #ff8f89;
}
.sbox-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	flex-shrink: 0;
}
.sbox-dot-on {
	background: var(--sbox-success);
	box-shadow: 0 0 8px rgba(46, 204, 113, 0.5);
}
.sbox-dot-off {
	background: var(--sbox-danger);
}
.sbox-proxy-mode-inline {
	font-size: 11px;
	color: var(--sbox-muted);
	text-transform: uppercase;
	letter-spacing: 0.06em;
}
.sbox-mode-select {
	min-width: 96px;
	height: 24px;
	padding: 0 6px;
	font-size: 11px;
	background: var(--sbox-card);
	color: var(--sbox-text);
	border: 1px solid var(--sbox-border);
	border-radius: 6px;
}
.sbox-mode-select:disabled {
	opacity: 0.75;
}
.sbox-config-toolbar {
	display: grid;
	grid-template-columns: minmax(140px, 180px) minmax(220px, 1fr) minmax(240px, auto);
	gap: 8px;
	align-items: center;
	margin-bottom: 10px;
}
.sbox-save-update-sub {
	width: 100%;
	min-height: 32px;
	font-weight: 700;
}
.sbox-select,
.sbox-input {
	width: 100%;
	box-sizing: border-box;
}
.sbox-editor {
	width: 100%;
	height: 560px;
	border: 1px solid var(--sbox-border);
	border-radius: 8px;
}
.sbox-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-top: 10px;
}
.sbox-config-footer {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	flex-wrap: wrap;
	margin-top: 8px;
}
.sbox-muted {
	color: var(--sbox-muted);
	font-size: 12px;
	line-height: 1.5;
}
.sbox-log-toolbar {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
}
.sbox-log-updated {
	margin-left: auto;
	color: var(--sbox-muted);
	font-size: 12px;
}
.sbox-log-content {
	width: 100%;
	height: 520px;
	overflow: auto;
	background: var(--sbox-log-bg);
	border: 1px solid var(--sbox-border);
	border-radius: 8px;
	padding: 10px;
	box-sizing: border-box;
	margin: 0;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
	font-size: 11.5px;
	line-height: 1.45;
	white-space: pre;
}
.sbox-log-info { color: #4dd58a; }
.sbox-log-warn { color: #e6b450; }
.sbox-log-error { color: #ff7b72; }
.sbox-log-muted { color: #93a4be; }
.sbox-settings-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(220px, 1fr));
	gap: 10px;
}
.sbox-settings-block {
	border: 1px solid var(--sbox-border);
	border-radius: 8px;
	padding: 10px;
	background: var(--sbox-panel-bg);
}
.sbox-settings-block h4 {
	margin: 0 0 8px;
	font-size: 13px;
	color: var(--sbox-text);
}
.sbox-settings-block-wide {
	grid-column: 1 / -1;
}
.sbox-radio-row,
.sbox-checkbox-row {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	margin: 6px 0;
	font-size: 12px;
}
.sbox-form-grid {
	margin-top: 8px;
	display: grid;
	grid-template-columns: repeat(2, minmax(180px, 1fr));
	gap: 8px;
}
.sbox-form-grid label {
	display: block;
	margin-bottom: 4px;
	font-size: 12px;
	color: var(--sbox-muted);
}
.sbox-interface-group {
	margin-bottom: 8px;
}
.sbox-interface-group-title {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--sbox-muted);
	margin-bottom: 4px;
}
.sbox-interface-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 6px;
}
.sbox-interface-item {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 12px;
	border: 1px solid var(--sbox-border);
	border-radius: 6px;
	padding: 5px 8px;
	background: rgba(255, 255, 255, 0.02);
}
.sbox-interface-item em {
	color: #63d996;
	font-style: normal;
	font-size: 11px;
}
.sbox-interface-auto {
	border-color: rgba(46, 204, 113, 0.55);
	background: rgba(46, 204, 113, 0.08);
}
.sbox-settings-status {
	margin-top: 10px;
	border-left: 3px solid var(--sbox-accent);
	padding: 8px 10px;
	border-radius: 0 6px 6px 0;
	background: rgba(255, 255, 255, 0.04);
	font-size: 12px;
	color: var(--sbox-text);
	line-height: 1.5;
}
.sbox-settings-gap {
	height: 12px;
}
.sbox-settings-save-wrap {
	margin-top: 12px;
}
.sbox-settings-save-btn {
	width: 100%;
	min-height: 42px;
	padding-top: 10px;
	padding-bottom: 10px;
}
@keyframes sbox-spin { to { transform: rotate(360deg); } }
.sbox-spinner {
	display: inline-block;
	width: 0.75em;
	height: 0.75em;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	animation: sbox-spin 0.65s linear infinite;
	vertical-align: -0.1em;
}
.sbox-modal-overlay {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.7);
	z-index: 10000;
	display: flex;
	align-items: center;
	justify-content: center;
}
.sbox-modal {
	width: min(92vw, 420px);
	border: 1px solid var(--sbox-border, #2a2d33);
	border-radius: 10px;
	background: var(--sbox-modal-bg, #171a1f);
	color: var(--sbox-text, #e3e6eb);
	padding: 14px;
	box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
}
.sbox-modal-title {
	font-size: 14px;
	font-weight: 700;
	margin-bottom: 8px;
}
.sbox-modal-body {
	color: var(--sbox-muted, #8f97a3);
	font-size: 12px;
	line-height: 1.5;
}
.sbox-modal-actions {
	margin-top: 12px;
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	justify-content: flex-end;
}
.sbox-modal-wide {
	width: min(96vw, 1180px);
	max-height: 92vh;
}
.sbox-modal-wide .sbox-modal-body {
	max-height: calc(92vh - 104px);
	overflow: hidden;
}
.sbox-rulesets-modal-body {
	color: var(--sbox-text);
}
.sbox-rulesets-layout {
	display: grid;
	grid-template-columns: minmax(230px, 280px) minmax(0, 1fr);
	gap: 12px;
}
.sbox-rulesets-sidebar,
.sbox-rulesets-main {
	border: 1px solid var(--sbox-border);
	border-radius: 8px;
	background: var(--sbox-panel-bg);
	padding: 10px;
}
.sbox-rulesets-title {
	font-size: 13px;
	font-weight: 700;
	margin-bottom: 6px;
}
.sbox-rulesets-create-row {
	margin-top: 8px;
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 8px;
}
.sbox-rulesets-list {
	margin-top: 10px;
	display: flex;
	flex-direction: column;
	gap: 6px;
	max-height: 55vh;
	overflow: auto;
}
.sbox-ruleset-list-item {
	width: 100%;
	text-align: left;
	border: 1px solid var(--sbox-border);
	border-radius: 6px;
	background: rgba(255, 255, 255, 0.02);
	color: var(--sbox-text);
	padding: 6px 8px;
	cursor: pointer;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
	font-size: 12px;
}
.sbox-ruleset-list-item:hover {
	border-color: var(--sbox-accent);
}
.sbox-ruleset-list-item.active {
	border-color: var(--sbox-accent);
	background: rgba(92, 112, 136, 0.2);
}
.sbox-rulesets-toolbar {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
}
.sbox-ruleset-current {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
	font-size: 12px;
	color: var(--sbox-muted);
}
.sbox-rulesets-toolbar-actions {
	margin-left: auto;
	display: flex;
	gap: 8px;
}
.sbox-ruleset-editor-wrap {
	display: none;
}
.sbox-ruleset-editor {
	height: 48vh;
	min-height: 320px;
	border: 1px solid var(--sbox-border);
	border-radius: 8px;
}
.sbox-rulesets-empty {
	border: 1px dashed var(--sbox-border);
	border-radius: 8px;
	padding: 16px;
	color: var(--sbox-muted);
	font-size: 12px;
}
.sbox-rulesets-example {
	margin-top: 8px;
}
.sbox-rulesets-example pre {
	margin: 0;
	border: 1px solid var(--sbox-border);
	border-radius: 6px;
	padding: 8px;
	background: var(--sbox-log-bg);
	font-size: 11px;
	line-height: 1.45;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
.sbox-rulesets-whitelist {
	margin-top: 10px;
	border: 1px solid rgba(46, 204, 113, 0.35);
	border-radius: 8px;
	padding: 10px;
	background: rgba(46, 204, 113, 0.06);
}
.sbox-rulesets-whitelist-head {
	font-size: 13px;
	font-weight: 700;
	margin-bottom: 4px;
}
.sbox-ruleset-whitelist-editor {
	height: 240px;
	border: 1px solid var(--sbox-border);
	border-radius: 8px;
}
.sbox-page.sbox-theme-light .sbox-ruleset-list-item {
	background: #f3f6fb;
}
.sbox-page.sbox-theme-light .sbox-ruleset-list-item.active {
	background: #dde9ff;
}
.sbox-page.sbox-theme-light .sbox-rulesets-whitelist {
	background: #eefbf3;
}
@media (max-width: 980px) {
	.sbox-config-toolbar {
		grid-template-columns: 1fr;
	}
	.sbox-settings-grid {
		grid-template-columns: 1fr;
	}
	.sbox-form-grid {
		grid-template-columns: 1fr;
	}
	.sbox-modal-wide {
		width: min(98vw, 980px);
	}
	.sbox-rulesets-layout {
		grid-template-columns: 1fr;
	}
	.sbox-rulesets-list {
		max-height: 220px;
	}
	.sbox-ruleset-editor {
		height: 42vh;
		min-height: 280px;
	}
}
`;

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load: function() {
		return Promise.all([
			L.resolveDefault(fs.read(CONFIG_PATH), ''),
			readSubscriptionUrl(),
			readThemePreference(),
			loadOperationalSettings(),
			getNetworkInterfaces(),
			getVersions(),
			getKernelStatus(),
			getServiceStatus(),
			detectCurrentProxyMode()
		]);
	},

	render: async function(data) {
		await ensureConfigProfilesReady(data[0] || '');
		appState.configProfiles = CONFIG_PROFILES.slice();
		appState.selectedConfigName = MAIN_CONFIG_NAME;
		appState.configContent = await readConfigFileByName(MAIN_CONFIG_NAME);
		appState.subscriptionUrl = await readSubscriptionUrl(MAIN_CONFIG_NAME);
		const savedTheme = String(data[2] || '').trim();
		appState.uiTheme = savedTheme ? normalizeTheme(savedTheme) : detectInitialTheme();
		appState.settings = data[3] || await loadOperationalSettings();
		appState.interfaces = data[4] || [];
		appState.versions = data[5] || { app: 'unknown', core: 'unknown' };
		appState.kernelStatus = data[6] || createEmptyKernelStatus();
		if (appState.kernelStatus && appState.kernelStatus.version) {
			appState.versions.core = appState.kernelStatus.version;
		}
		appState.serviceRunning = !!data[7];
		appState.proxyMode = data[8] || 'tproxy';

		appState.selectedInterfaces = await loadInterfacesByMode(appState.settings.mode || 'exclude');
		appState.detectedLan = appState.settings.detectedLan || (await detectLanBridge()) || '';
		appState.detectedWan = appState.settings.detectedWan || (await detectWanInterface()) || '';

		pageRoot = E('div', { 'class': 'sbox-page' }, [
			E('style', {}, PAGE_CSS),
			E('div', { 'id': 'sbox-root' })
		]);

		pageRoot.querySelector('#sbox-root').innerHTML = buildPageHtml();
		applyUiTheme(appState.uiTheme);
		if (!savedTheme) {
			saveThemePreference(appState.uiTheme).catch(() => {});
		}

		try {
			await initializeAceEditor(appState.configContent);
		} catch (e) {
			notify('error', _('Failed to initialize editor: %s').format(e.message));
		}

		bindControlAndHeaderEvents();
		bindConfigEvents();
		bindTabEvents();
		renderSettingsPane();
		updateHeaderAndControlDom();
		refreshReleaseMeta({ force: true }).catch(() => {});
		ensureKernelFirstRunPrompt().catch(() => {});

		startControlPolling();
		startUpdatePolling();

		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				stopLogPolling();
			} else if (appState.activeCfgTab === 'logs') {
				refreshLogs().catch(() => {});
				startLogPolling();
			}
			if (!document.hidden) {
				refreshReleaseMeta({ force: false }).catch(() => {});
			}
		});

		return pageRoot;
	}
});


