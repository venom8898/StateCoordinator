import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    getCurrentChatId,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

const EXTENSION_NAME = 'StateCoordinator';
const PROMPT_KEY = 'state_coordinator';
const UI_ID = 'state-coordinator-actions';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    consumeCommands: true,
    caseSensitive: false,
    role: 'system',
    position: 'before_prompt',
    depth: 0,
    promptHeader: 'Maintain the following established story state and continuity constraints:',
    definitions: [],
    conversations: {},
});

let settings;
let currentScope = null;
let oneShotGuide = '';

function notify(message, type = 'info') {
    if (window.toastr?.[type]) window.toastr[type](message, 'State Coordinator');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normaliseDefinition(raw, index = 0) {
    const name = String(raw?.name ?? raw?.id ?? `State ${index + 1}`).trim();
    return {
        id: String(raw?.id || crypto.randomUUID?.() || `state-${Date.now()}-${index}`),
        name,
        prompt: String(raw?.prompt ?? raw?.message_in ?? '').trim(),
        enter: Array.isArray(raw?.enter) ? raw.enter : (raw?.keywords_in || []),
        exit: Array.isArray(raw?.exit) ? raw.exit : (raw?.keywords_out || []),
        enabled: raw?.enabled !== false,
    };
}

function migrateSettings(saved) {
    const merged = { ...clone(DEFAULT_SETTINGS), ...(saved || {}) };
    merged.definitions = (merged.definitions || []).map(normaliseDefinition);
    merged.conversations = merged.conversations || {};

    // Migrate the original character-name keyed storage without discarding it.
    if (saved?.activeStates && !Object.keys(merged.conversations).length) {
        for (const [character, stateNames] of Object.entries(saved.activeStates)) {
            merged.conversations[`legacy:${character}`] = {
                active: (stateNames || []).map(String),
                custom: saved.customStates?.[character] || '',
            };
        }
    }
    return merged;
}

async function loadBundledDefinitions() {
    if (settings.definitions.length) return;
    try {
        const response = await fetch('scripts/extensions/third-party/StateCoordinator/states.json', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        const loaded = [];
        for (const entry of data.states || []) {
            if (typeof entry === 'object') {
                loaded.push(normaliseDefinition(entry, loaded.length));
                continue;
            }
            const stateResponse = await fetch(
                `scripts/extensions/third-party/StateCoordinator/states/${encodeURIComponent(entry)}.json`,
                { cache: 'no-store' },
            );
            if (stateResponse.ok) {
                loaded.push(normaliseDefinition({ ...(await stateResponse.json()), id: entry, name: entry }, loaded.length));
            }
        }
        if (loaded.length) {
            settings.definitions = loaded;
            persist();
        }
    } catch (error) {
        console.warn(`${EXTENSION_NAME}: Could not load bundled definitions.`, error);
    }
}

function persist() {
    extension_settings[EXTENSION_NAME] = settings;
    saveSettingsDebounced();
}

function contextScope() {
    const context = getContext();
    const conversation = getCurrentChatId?.()
        || context.chatId
        || context.chatMetadata?.chat_id
        || context.chat?.[0]?.send_date
        || 'new-chat';
    if (context.groupId) return `group:${context.groupId}:${conversation}`;
    if (context.characterId !== undefined && context.characterId !== null) {
        return `character:${context.characterId}:${conversation}`;
    }
    return null;
}

function scopeState(create = true) {
    if (!currentScope) return null;
    if (!settings.conversations[currentScope] && create) {
        settings.conversations[currentScope] = { active: [], custom: '' };
    }
    return settings.conversations[currentScope] || null;
}

function roleValue() {
    return {
        system: extension_prompt_roles.SYSTEM,
        assistant: extension_prompt_roles.ASSISTANT,
        user: extension_prompt_roles.USER,
    }[settings.role] ?? extension_prompt_roles.SYSTEM;
}

function positionValue() {
    return settings.position === 'in_chat'
        ? extension_prompt_types.IN_CHAT
        : extension_prompt_types.BEFORE_PROMPT;
}

function buildPrompt() {
    if (!settings.enabled || !currentScope) return '';
    const scoped = scopeState(false);
    const activeIds = new Set(scoped?.active || []);
    const prompts = settings.definitions
        .filter(item => item.enabled && activeIds.has(item.id) && item.prompt)
        .map(item => `- ${item.name}: ${item.prompt}`);
    if (scoped?.custom?.trim()) prompts.push(`- Custom: ${scoped.custom.trim()}`);
    if (oneShotGuide.trim()) prompts.push(`- Next response only: ${oneShotGuide.trim()}`);
    if (!prompts.length) return '';
    return [settings.promptHeader.trim(), ...prompts].filter(Boolean).join('\n');
}

function syncPrompt() {
    setExtensionPrompt(
        PROMPT_KEY,
        buildPrompt(),
        positionValue(),
        Math.max(0, Number(settings.depth) || 0),
        false,
        roleValue(),
    );
}

function findMatches(text, commands) {
    if (!text || !commands?.length) return [];
    const source = settings.caseSensitive ? text : text.toLocaleLowerCase();
    return commands
        .map(command => String(command).trim())
        .filter(Boolean)
        .filter(command => source.includes(settings.caseSensitive ? command : command.toLocaleLowerCase()));
}

function removeMatches(text, matches) {
    let result = text;
    for (const match of matches) {
        const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped, settings.caseSensitive ? 'g' : 'gi'), '');
    }
    return result.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').trim();
}

function applyTransitions(message) {
    const scoped = scopeState();
    if (!scoped || !message) return false;
    const active = new Set(scoped.active || []);
    const consumed = [];
    let changed = false;

    for (const definition of settings.definitions.filter(item => item.enabled)) {
        const exitMatches = findMatches(message, definition.exit);
        const enterMatches = findMatches(message, definition.enter);
        if (exitMatches.length && active.delete(definition.id)) changed = true;
        if (enterMatches.length && !exitMatches.length && !active.has(definition.id)) {
            active.add(definition.id);
            changed = true;
        }
        consumed.push(...exitMatches, ...enterMatches);
    }

    const customMatch = message.match(/(?:^|\s)\/state\s+custom\s+(.+?)(?=$|\n)/i);
    const clearCustom = /(?:^|\s)\/state\s+custom\s+(?:off|clear)(?=$|\s)/i.test(message);
    if (clearCustom) {
        scoped.custom = '';
        changed = true;
    } else if (customMatch) {
        scoped.custom = customMatch[1].trim();
        changed = true;
    }

    scoped.active = [...active];
    if (changed) persist();
    syncPrompt();
    renderActiveStates();
    return settings.consumeCommands
        ? removeMatches(message, [...consumed, customMatch?.[0], clearCustom ? message.match(/(?:^|\s)\/state\s+custom\s+(?:off|clear)(?=$|\s)/i)?.[0] : null].filter(Boolean))
        : message;
}

async function generationInterceptor(chat) {
    currentScope = contextScope();
    const latestUser = [...chat].reverse().find(message => message?.is_user);
    if (latestUser?.mes) latestUser.mes = applyTransitions(latestUser.mes);
    else syncPrompt();
}

function setOneShotGuide(value) {
    oneShotGuide = String(value || '').trim();
    syncPrompt();
    renderActiveStates();
}

function getComposer() {
    return document.querySelector('#send_textarea');
}

function readAndClearComposer() {
    const composer = getComposer();
    const value = composer?.value?.trim() || '';
    if (composer && value) {
        composer.value = '';
        composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return value;
}

function installActionBar() {
    if (document.getElementById(UI_ID)) return;
    const sendForm = document.querySelector('#send_form');
    const composer = getComposer();
    if (!sendForm || !composer) return;

    const bar = document.createElement('div');
    bar.id = UI_ID;
    bar.innerHTML = `
        <button type="button" id="sc-guide-next" class="menu_button fa-solid fa-compass" title="Use the composer text to guide the next response"></button>
        <button type="button" id="sc-open-states" class="menu_button fa-solid fa-layer-group" title="Open State Coordinator settings"></button>
        <div id="sc-active-summary" aria-live="polite"></div>
    `;
    sendForm.insertAdjacentElement('beforebegin', bar);
    bar.querySelector('#sc-guide-next').addEventListener('click', async () => {
        const guide = readAndClearComposer();
        if (!guide) return notify('Type guidance in the message box first.', 'warning');
        setOneShotGuide(guide);
        notify('Guidance armed for the next response.');
        try {
            const context = getContext();
            if (typeof context.executeSlashCommandsWithOptions === 'function') {
                await context.executeSlashCommandsWithOptions('/trigger await=true');
            } else {
                throw new Error('This SillyTavern version does not expose the generation trigger.');
            }
        } catch (error) {
            console.error(`${EXTENSION_NAME}: could not start guided response`, error);
            notify('Guidance is armed, but generation could not be started automatically.', 'warning');
        }
    });
    bar.querySelector('#sc-open-states').addEventListener('click', () => {
        document.querySelector('.statecoordinator_settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.querySelector('.statecoordinator_settings .inline-drawer-content')?.classList.remove('closedDrawer');
    });
    renderActiveStates();
}

function renderActiveStates() {
    const summary = document.getElementById('sc-active-summary');
    if (!summary) return;
    const scoped = scopeState(false);
    const active = new Set(scoped?.active || []);
    const names = settings.definitions.filter(item => active.has(item.id)).map(item => item.name);
    if (scoped?.custom) names.push('Custom');
    if (oneShotGuide) names.push('Next guide');
    summary.replaceChildren(...names.map(name => {
        const chip = document.createElement('span');
        chip.className = 'sc-chip';
        chip.textContent = name;
        return chip;
    }));
}

function commaList(value) {
    return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function renderDefinitions() {
    const list = document.getElementById('sc-definition-list');
    if (!list) return;
    const scoped = scopeState();
    const active = new Set(scoped?.active || []);
    list.replaceChildren();

    for (const definition of settings.definitions) {
        const row = document.createElement('details');
        row.className = 'sc-definition';
        row.dataset.id = definition.id;
        row.innerHTML = `
            <summary>
                <input class="sc-active-toggle" type="checkbox" ${active.has(definition.id) ? 'checked' : ''} aria-label="Activate ${escapeHtml(definition.name)}">
                <span>${escapeHtml(definition.name)}</span>
                <span class="sc-status">${definition.enabled ? '' : 'disabled'}</span>
            </summary>
            <div class="sc-definition-fields">
                <label>Name<input class="text_pole sc-name" value="${escapeHtml(definition.name)}"></label>
                <label>Prompt<textarea class="text_pole sc-prompt" rows="3">${escapeHtml(definition.prompt)}</textarea></label>
                <label>Enter commands <small>(comma-separated)</small><input class="text_pole sc-enter" value="${escapeHtml(definition.enter.join(', '))}"></label>
                <label>Exit commands <small>(comma-separated)</small><input class="text_pole sc-exit" value="${escapeHtml(definition.exit.join(', '))}"></label>
                <label class="checkbox_label"><input class="sc-enabled" type="checkbox" ${definition.enabled ? 'checked' : ''}> Definition enabled</label>
                <button type="button" class="menu_button sc-delete"><i class="fa-solid fa-trash"></i> Delete</button>
            </div>
        `;
        row.querySelector('.sc-active-toggle').addEventListener('change', event => {
            event.stopPropagation();
            if (event.target.checked) active.add(definition.id);
            else active.delete(definition.id);
            scoped.active = [...active];
            persist();
            syncPrompt();
            renderActiveStates();
        });
        row.querySelector('.sc-definition-fields').addEventListener('change', () => {
            definition.name = row.querySelector('.sc-name').value.trim() || 'Untitled state';
            definition.prompt = row.querySelector('.sc-prompt').value.trim();
            definition.enter = commaList(row.querySelector('.sc-enter').value);
            definition.exit = commaList(row.querySelector('.sc-exit').value);
            definition.enabled = row.querySelector('.sc-enabled').checked;
            persist();
            syncPrompt();
            renderDefinitions();
            renderActiveStates();
        });
        row.querySelector('.sc-delete').addEventListener('click', () => {
            settings.definitions = settings.definitions.filter(item => item.id !== definition.id);
            for (const value of Object.values(settings.conversations)) {
                value.active = (value.active || []).filter(id => id !== definition.id);
            }
            persist();
            syncPrompt();
            renderDefinitions();
            renderActiveStates();
        });
        list.append(row);
    }
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

function bindSettings() {
    const root = document.querySelector('.statecoordinator_settings');
    if (!root) return;

    for (const element of root.querySelectorAll('[data-setting]')) {
        const key = element.dataset.setting;
        element.type === 'checkbox' ? element.checked = Boolean(settings[key]) : element.value = settings[key];
        element.addEventListener('change', () => {
            settings[key] = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value;
            persist();
            syncPrompt();
        });
    }

    const custom = root.querySelector('#sc-custom-state');
    custom.value = scopeState()?.custom || '';
    custom.addEventListener('input', () => {
        const scoped = scopeState();
        if (!scoped) return;
        scoped.custom = custom.value;
        persist();
        syncPrompt();
        renderActiveStates();
    });

    root.querySelector('#sc-add-state').addEventListener('click', () => {
        settings.definitions.push(normaliseDefinition({ name: 'New state', prompt: '', enter: [], exit: [] }, settings.definitions.length));
        persist();
        renderDefinitions();
    });
    root.querySelector('#sc-clear-active').addEventListener('click', () => {
        const scoped = scopeState();
        if (!scoped) return;
        scoped.active = [];
        scoped.custom = '';
        setOneShotGuide('');
        persist();
        custom.value = '';
        renderDefinitions();
    });
    root.querySelector('#sc-export').addEventListener('click', exportDefinitions);
    root.querySelector('#sc-import-file').addEventListener('change', importDefinitions);
    renderDefinitions();
}

function exportDefinitions() {
    const blob = new Blob([JSON.stringify({ version: 1, states: settings.definitions }, null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'state-coordinator-states.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}

async function importDefinitions(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
        const parsed = JSON.parse(await file.text());
        const incoming = Array.isArray(parsed) ? parsed : parsed.states;
        if (!Array.isArray(incoming)) throw new Error('The file does not contain a states array.');
        settings.definitions = incoming.map(normaliseDefinition);
        persist();
        syncPrompt();
        renderDefinitions();
        renderActiveStates();
        notify(`Imported ${settings.definitions.length} states.`, 'success');
    } catch (error) {
        notify(`Import failed: ${error.message}`, 'error');
    }
}

async function onChatChanged() {
    currentScope = contextScope();
    oneShotGuide = '';
    syncPrompt();
    renderDefinitions();
    renderActiveStates();
    const custom = document.getElementById('sc-custom-state');
    if (custom) custom.value = scopeState(false)?.custom || '';
}

async function initialise() {
    extension_settings[EXTENSION_NAME] = migrateSettings(extension_settings[EXTENSION_NAME]);
    settings = extension_settings[EXTENSION_NAME];
    await loadBundledDefinitions();
    currentScope = contextScope();

    const html = renderExtensionTemplateAsync
        ? await renderExtensionTemplateAsync(`third-party/${EXTENSION_NAME}`, 'settings')
        : await (await fetch('scripts/extensions/third-party/StateCoordinator/settings.html')).text();
    document.querySelector('#extensions_settings')?.insertAdjacentHTML('beforeend', html);
    bindSettings();
    installActionBar();
    syncPrompt();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    // One-shot guidance must never leak into a later generation.
    const generationEvents = getContext().eventTypes || event_types;
    if (generationEvents.GENERATION_ENDED) eventSource.on(generationEvents.GENERATION_ENDED, () => setOneShotGuide(''));
    if (generationEvents.GENERATION_STOPPED) eventSource.on(generationEvents.GENERATION_STOPPED, () => setOneShotGuide(''));

    const observer = new MutationObserver(() => {
        if (!document.getElementById(UI_ID)) installActionBar();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    console.info(`${EXTENSION_NAME}: ready`);
}

window.StateCoordinator_Intercept = generationInterceptor;

jQuery(async () => {
    try {
        await initialise();
    } catch (error) {
        console.error(`${EXTENSION_NAME}: failed to initialise`, error);
        notify('Failed to initialise. See the browser console for details.', 'error');
    }
});
