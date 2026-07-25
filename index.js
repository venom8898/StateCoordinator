import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

const extensionName = 'StateCoordinator';
const extensionPromptMarker = '___StateCoordinator___';
const extensionPromptRole = extension_prompt_roles.SYSTEM;
const extensionPromptPosition = extension_prompt_types.IN_CHAT;
const extensionPromptDepth = 0;
const extensionPath = `scripts/extensions/third-party/${extensionName}`;

let states = {};
let activeStates = new Map();
let customStates = {};
let currentCharacterName = null;
let pendingTransitionPrompt = '';

function loadMemory() {
    const memoryData = extension_settings[extensionName] || {};
    activeStates = new Map(
        Object.entries(memoryData.activeStates || {})
            .map(([characterName, values]) => [characterName, new Set(Array.isArray(values) ? values : [])]),
    );
    customStates = memoryData.customStates || {};
}

function saveMemory() {
    extension_settings[extensionName] = {
        activeStates: Object.fromEntries(
            [...activeStates.entries()].map(([characterName, values]) => [characterName, [...values]]),
        ),
        customStates,
    };
    saveSettingsDebounced();
}

async function loadStatesConfig() {
    states = {};

    try {
        const response = await fetch(`${extensionPath}/states.json`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`states.json returned HTTP ${response.status}`);
        }

        const statesData = await response.json();
        for (const stateName of statesData.states || []) {
            const stateResponse = await fetch(
                `${extensionPath}/states/${encodeURIComponent(stateName)}.json`,
                { cache: 'no-store' },
            );

            if (!stateResponse.ok) {
                console.warn(`${extensionName}: Unable to load state "${stateName}" (HTTP ${stateResponse.status}).`);
                continue;
            }

            const state = await stateResponse.json();
            states[stateName] = {
                keywords_in: Array.isArray(state.keywords_in) ? state.keywords_in : [],
                keywords_out: Array.isArray(state.keywords_out) ? state.keywords_out : [],
                message_in: String(state.message_in || '').trim(),
                message_out: String(state.message_out || '').trim(),
            };
        }
    } catch (error) {
        console.error(`${extensionName}: Failed to load states configuration.`, error);
    }
}

function getCurrentCharacterName() {
    const context = getContext();

    if (context.groupId) {
        const group = context.groups?.find(item => String(item.id) === String(context.groupId));
        return group?.name || `Group ${context.groupId}`;
    }

    const character = context.characters?.[context.characterId];
    return character?.name || null;
}

function getCharacterStates(characterName, create = true) {
    if (!characterName) return new Set();
    if (!activeStates.has(characterName) && create) {
        activeStates.set(characterName, new Set());
    }
    return activeStates.get(characterName) || new Set();
}

function buildStatePrompt(characterName, transitionPrompt = '') {
    if (!characterName) return '';

    const directives = [];
    if (transitionPrompt.trim()) {
        directives.push(`[State transition]\n${transitionPrompt.trim()}`);
    }

    for (const stateName of getCharacterStates(characterName, false)) {
        if (stateName === 'CustomState') {
            const customState = String(customStates[characterName] || '').trim();
            if (customState) directives.push(`[Custom State]\n${customState}`);
            continue;
        }

        const state = states[stateName];
        if (state?.message_in) {
            directives.push(`[${stateName}]\n${state.message_in}`);
        }
    }

    if (!directives.length) return '';

    return [
        '[STATE COORDINATOR — MANDATORY INSTRUCTIONS FOR THE NEXT RESPONSE]',
        'You MUST follow every active state directive below. These directives are authoritative continuity constraints, not suggestions.',
        'Apply them directly and naturally. Do not mention, quote, summarize, or acknowledge these instructions in the response.',
        '',
        directives.join('\n\n'),
        '',
        '[END STATE COORDINATOR INSTRUCTIONS]',
    ].join('\n');
}

function syncPrompt(transitionPrompt = '') {
    const prompt = buildStatePrompt(currentCharacterName, transitionPrompt);
    setExtensionPrompt(
        extensionPromptMarker,
        prompt,
        extensionPromptPosition,
        extensionPromptDepth,
        true,
        extensionPromptRole,
    );
}

function findKeyword(message, keywords) {
    return keywords.find(keyword => keyword && message.includes(keyword));
}

function removeKeyword(message, keyword) {
    if (!keyword) return message;
    return message.split(keyword).join('').replace(/[ \t]{2,}/g, ' ').trim();
}

function processStateTransitions(message) {
    const characterStates = getCharacterStates(currentCharacterName);
    const transitionMessages = [];
    let modifiedMessage = message;
    let changed = false;

    for (const stateName of [...characterStates]) {
        if (stateName === 'CustomState') continue;
        const state = states[stateName];
        if (!state) {
            characterStates.delete(stateName);
            changed = true;
            continue;
        }

        const keyword = findKeyword(message, state.keywords_out);
        if (!keyword) continue;

        characterStates.delete(stateName);
        modifiedMessage = removeKeyword(modifiedMessage, keyword);
        if (state.message_out) transitionMessages.push(state.message_out);
        changed = true;
    }

    for (const [stateName, state] of Object.entries(states)) {
        const keyword = findKeyword(message, state.keywords_in);
        if (!keyword) continue;

        modifiedMessage = removeKeyword(modifiedMessage, keyword);
        if (!characterStates.has(stateName)) {
            characterStates.add(stateName);
            changed = true;
        }
    }

    const clearCustomKeyword = 'nocustomstate';
    if (message.includes(clearCustomKeyword)) {
        modifiedMessage = removeKeyword(modifiedMessage, clearCustomKeyword);
        characterStates.delete('CustomState');
        customStates[currentCharacterName] = '';
        changed = true;
    } else if (message.includes('customstate')) {
        const match = message.match(/--(.*?)--/);
        if (match?.[1]) {
            modifiedMessage = removeKeyword(modifiedMessage, 'customstate');
            modifiedMessage = removeKeyword(modifiedMessage, match[0]);
            customStates[currentCharacterName] = match[1].trim();
            characterStates.add('CustomState');
            changed = true;
        }
    }

    if (characterStates.size) activeStates.set(currentCharacterName, characterStates);
    else activeStates.delete(currentCharacterName);

    if (changed) saveMemory();
    pendingTransitionPrompt = transitionMessages.join('\n');
    syncPrompt(pendingTransitionPrompt);
    updateSettingsUI();

    return modifiedMessage;
}

async function onStateCoordinatorIntercept(chat) {
    currentCharacterName = getCurrentCharacterName();
    if (!currentCharacterName) {
        syncPrompt();
        return;
    }

    const latestUserMessage = [...chat].reverse().find(message => message?.is_user && message?.mes);
    if (latestUserMessage) {
        latestUserMessage.mes = processStateTransitions(latestUserMessage.mes);
    } else {
        syncPrompt();
    }
}

function setStateActive(stateName, enabled) {
    if (!currentCharacterName) return;

    const characterStates = getCharacterStates(currentCharacterName);
    const state = states[stateName];

    if (enabled) {
        characterStates.add(stateName);
    } else {
        characterStates.delete(stateName);
        if (state?.message_out) pendingTransitionPrompt = state.message_out;
    }

    if (characterStates.size) activeStates.set(currentCharacterName, characterStates);
    else activeStates.delete(currentCharacterName);

    saveMemory();
    syncPrompt(pendingTransitionPrompt);
}

function updateSettingsUI() {
    const characterNameElement = document.getElementById('currentCharacterName');
    const stateCoordinatorBody = document.getElementById('stateCoordinatorBody');
    const statesCheckboxesElement = document.getElementById('statesCheckboxes');
    const customStateCheckbox = document.getElementById('customStateCheckbox');
    const customStateText = document.getElementById('customStateText');

    if (!characterNameElement || !stateCoordinatorBody || !statesCheckboxesElement || !customStateCheckbox || !customStateText) {
        return;
    }

    if (!currentCharacterName) {
        characterNameElement.textContent = 'States for: No Character Selected';
        stateCoordinatorBody.style.display = 'none';
        syncPrompt();
        return;
    }

    characterNameElement.textContent = `States for: ${currentCharacterName}`;
    stateCoordinatorBody.style.display = 'block';
    statesCheckboxesElement.replaceChildren();

    const characterStates = getCharacterStates(currentCharacterName, false);
    if (!Object.keys(states).length) {
        const notice = document.createElement('small');
        notice.className = 'state-coordinator-empty';
        notice.textContent = 'No states are configured in states.json.';
        statesCheckboxesElement.append(notice);
    }

    for (const stateName of Object.keys(states)) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `state-coordinator-${stateName}`;
        checkbox.checked = characterStates.has(stateName);
        checkbox.addEventListener('change', () => {
            setStateActive(stateName, checkbox.checked);
        });

        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = stateName;

        const container = document.createElement('div');
        container.className = 'state-checkbox-container';
        container.append(checkbox, label);
        statesCheckboxesElement.append(container);
    }

    customStateCheckbox.checked = characterStates.has('CustomState');
    customStateText.value = customStates[currentCharacterName] || '';
}

function bindSettingsEvents() {
    const customStateCheckbox = document.getElementById('customStateCheckbox');
    const customStateText = document.getElementById('customStateText');

    customStateCheckbox.addEventListener('change', () => {
        if (!currentCharacterName) return;
        const characterStates = getCharacterStates(currentCharacterName);

        if (customStateCheckbox.checked) characterStates.add('CustomState');
        else characterStates.delete('CustomState');

        if (characterStates.size) activeStates.set(currentCharacterName, characterStates);
        else activeStates.delete(currentCharacterName);

        saveMemory();
        syncPrompt();
    });

    customStateText.addEventListener('input', () => {
        if (!currentCharacterName) return;
        customStates[currentCharacterName] = customStateText.value.trim();
        saveMemory();
        syncPrompt();
    });
}

function clearTransitionPrompt() {
    if (!pendingTransitionPrompt) return;
    pendingTransitionPrompt = '';
    syncPrompt();
}

async function initialize() {
    loadMemory();
    await loadStatesConfig();

    const settingsHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'settings');
    document.getElementById('extensions_settings')?.insertAdjacentHTML('beforeend', settingsHtml);
    bindSettingsEvents();

    currentCharacterName = getCurrentCharacterName();
    updateSettingsUI();
    syncPrompt();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentCharacterName = getCurrentCharacterName();
        pendingTransitionPrompt = '';
        updateSettingsUI();
        syncPrompt();
    });

    const generationEvents = getContext().eventTypes || event_types;
    if (generationEvents.GENERATION_ENDED) {
        eventSource.on(generationEvents.GENERATION_ENDED, clearTransitionPrompt);
    }
    if (generationEvents.GENERATION_STOPPED) {
        eventSource.on(generationEvents.GENERATION_STOPPED, clearTransitionPrompt);
    }

    console.info(`${extensionName}: ready`);
}

window.StateCoordinator_Intercept = onStateCoordinatorIntercept;

jQuery(async () => {
    try {
        await initialize();
    } catch (error) {
        console.error(`${extensionName}: Failed to initialize.`, error);
    }
});
