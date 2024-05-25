import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles, eventSource, event_types } from "../../../../script.js";
import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "StateCoordinator";
const extensionPromptMarker = '___StateCoordinator___';
const extensionPromptRole = extension_prompt_roles.SYSTEM;
const extensionPromptPosition = extension_prompt_types.BEFORE_PROMPT;
const extensionPromptDepth = 1;

console.log('StateCoordinator: Launched');

let states = {};
let activeStates = new Map(); // To store states for each character
let customStates = {}; // To store custom states per character
let currentCharacterId = null; // To store the currently selected character ID

// Load the states configuration
async function loadStatesConfig() {
    try {
        const response = await fetch('scripts/extensions/third-party/StateCoordinator/states.json');
        const statesData = await response.json();
        for (let state of statesData.states) {
            const stateResponse = await fetch(`scripts/extensions/third-party/StateCoordinator/states/${state}.json`);
            states[state] = await stateResponse.json();
        }
        console.log("StateCoordinator: Loaded states configuration", states);
    } catch (error) {
        console.error("StateCoordinator: Failed to load states configuration", error);
    }
}

// Load the states from the extension settings
function loadMemory() {
    const memoryData = extension_settings[extensionName] || {};
    activeStates = new Map(Object.entries(memoryData.activeStates || {}).map(([key, value]) => [key, new Set(value)]));
    customStates = memoryData.customStates || {};
    console.log("StateCoordinator: Loaded memory", memoryData);
}

// Save the states to the extension settings
function saveMemory() {
    const memoryData = {
        activeStates: Object.fromEntries(Array.from(activeStates.entries()).map(([key, value]) => [key, Array.from(value)])),
        customStates: customStates
    };
    extension_settings[extensionName] = memoryData;
    saveSettingsDebounced();
    console.log("StateCoordinator: Saved memory", memoryData);
}

// Update the system prompt with the current states for the selected character
function updateSystemPromptForCharacter(characterId) {
    let currentStates = activeStates.get(characterId) || new Set();
    let finalStatePrompt = '';

    for (let state of currentStates) {
        if (state === 'CustomState') {
            finalStatePrompt += `${customStates[characterId]}\n`;
        } else {
            const stateConfig = states[state];
            finalStatePrompt += `${stateConfig.message_in}\n`;
        }
    }

    if (finalStatePrompt.trim()) {
        console.log(`StateCoordinator: Injected system prompt: \n${finalStatePrompt.trim()}`);
        setExtensionPrompt(extensionPromptMarker, finalStatePrompt.trim(), extensionPromptPosition, extensionPromptDepth, false, extensionPromptRole);
    }

    console.log(`StateCoordinator: Current states for character ${characterId}:`, Array.from(currentStates));
}

async function onStateCoordinatorIntercept(chat) {
    if (!currentCharacterId) {
        console.log('StateCoordinator: No valid character ID found.');
        return;
    }

    // Find the latest user message
    let latestUserMessage = '';
    for (let message of chat.slice().reverse()) {
        if (message.is_user) {
            latestUserMessage = message.mes;
            break;
        }
    }

    if (!latestUserMessage) {
        console.log('StateCoordinator: No valid user message found.');
        return;
    }

    let currentStates = activeStates.get(currentCharacterId) || new Set();
    let modifiedMessage = latestUserMessage;
    let stateChanged = false;
    let statePrompt = '';
    let statesToRemove = new Set();
    let statesToAdd = new Set();

    // Check if the character is currently in any states and should be taken out
    for (let state of currentStates) {
        const stateConfig = states[state];
        const keywordsOut = stateConfig ? stateConfig.keywords_out : [];
        for (let keyword of keywordsOut) {
            if (latestUserMessage.includes(keyword)) {
                modifiedMessage = modifiedMessage.replace(keyword, '');
                if (state !== 'CustomState') {
                    statePrompt += `${stateConfig.message_out}\n`;
                }
                statesToRemove.add(state);
                stateChanged = true;
                console.log(`StateCoordinator: Character ${currentCharacterId} exited state ${state}`);
                break;
            }
        }
    }

    // Remove states marked for removal
    for (let state of statesToRemove) {
        currentStates.delete(state);
        if (state === 'CustomState') {
            customStates[currentCharacterId] = ''; // Clear custom state for this character
        }
    }

    // Check for keywords to bring the character into new states
    for (let state in states) {
        const stateConfig = states[state];
        const keywordsIn = stateConfig.keywords_in;
        for (let keyword of keywordsIn) {
            if (latestUserMessage.includes(keyword)) {
                modifiedMessage = modifiedMessage.replace(keyword, '');
                if (!currentStates.has(state) && !statesToRemove.has(state)) {
                    statePrompt += `${stateConfig.message_in}\n`;
                    statesToAdd.add(state);
                    stateChanged = true;
                    console.log(`StateCoordinator: Character ${currentCharacterId} entered state ${state}`);
                }
            }
        }
    }

    // Check for custom state keyword
    const customStateRegex = /--(.*?)--/;
    if (latestUserMessage.includes('customstate')) {
        const match = latestUserMessage.match(customStateRegex);
        if (match && match[1]) {
            modifiedMessage = modifiedMessage.replace('customstate', '').replace(match[0], '');
            customStates[currentCharacterId] = match[1].trim();
            currentStates.add('CustomState');
            stateChanged = true;
            console.log(`StateCoordinator: Character ${currentCharacterId} entered CustomState with custom prompt: ${customStates[currentCharacterId]}`);
        }
    }

    // Check for custom state exit keyword
    if (latestUserMessage.includes('nocustomstate')) {
        modifiedMessage = modifiedMessage.replace('nocustomstate', '');
        currentStates.delete('CustomState');
        customStates[currentCharacterId] = '';
        stateChanged = true;
        console.log(`StateCoordinator: Character ${currentCharacterId} exited CustomState`);
    }

    // Add states marked for addition
    for (let state of statesToAdd) {
        currentStates.add(state);
    }

    // Update active states for the character
    if (currentStates.size > 0) {
        activeStates.set(currentCharacterId, currentStates);
    } else {
        activeStates.delete(currentCharacterId);
    }

    // Save memory to settings
    saveMemory();

    // Construct the final state prompt for all current states
    let finalStatePrompt = '';
    for (let state of currentStates) {
        if (state === 'CustomState') {
            finalStatePrompt += `${customStates[currentCharacterId]}\n`;
        } else {
            const stateConfig = states[state];
            finalStatePrompt += `${stateConfig.message_in}\n`;
        }
    }

    // Always update the system prompt with the current states
    if (finalStatePrompt.trim() || stateChanged) {
        console.log(`StateCoordinator: Injected system prompt: \n${finalStatePrompt.trim()}`);
        setExtensionPrompt(extensionPromptMarker, finalStatePrompt.trim(), extensionPromptPosition, extensionPromptDepth, false, extensionPromptRole);
    }

    console.log('StateCoordinator intercepted message:', modifiedMessage);
    console.log("StateCoordinator: Active States", activeStates);
}

// Load the states configuration on start
loadStatesConfig();
loadMemory(); // Load memory on start

// Assign the interceptor function to be used
window['StateCoordinator_Intercept'] = onStateCoordinatorIntercept;

// Listener for chat selection change
eventSource.on(event_types.CHAT_CHANGED, (newCharacterId) => {
    currentCharacterId = newCharacterId;
    console.log(`StateCoordinator: Chat selected for character ${currentCharacterId}`);
    updateSystemPromptForCharacter(currentCharacterId);
});

// Add a listener to window unload to save memory before the user leaves the page
window.addEventListener('beforeunload', () => {
    saveMemory();
    console.log('StateCoordinator: Memory saved on unload');
});

// Load and append the settings HTML
fetch('scripts/extensions/third-party/StateCoordinator/settings.html')
    .then(response => response.text())
    .then(settingsHtml => {
        $("#extensions_settings").append(settingsHtml);
        setupSettings();
    });

function setupSettings() {
    const characterNameElement = document.getElementById("currentCharacterName");
    const statesCheckboxesElement = document.getElementById("statesCheckboxes");
    const customStateCheckbox = document.getElementById("customStateCheckbox");
    const customStateText = document.getElementById("customStateText");

    if (!characterNameElement || !statesCheckboxesElement || !customStateCheckbox || !customStateText) {
        console.error("StateCoordinator: Failed to initialize settings elements.");
        return;
    }

    // Function to update the settings UI based on the current character's states
    function updateSettingsUI() {
        if (!currentCharacterId) {
            characterNameElement.innerText = "States for: No Character Selected";
            statesCheckboxesElement.innerHTML = "";
            customStateCheckbox.checked = false;
            customStateText.value = "";
            customStateText.disabled = true;
            return;
        }

        characterNameElement.innerText = `States for: ${currentCharacterId}`;
        statesCheckboxesElement.innerHTML = "";

        const currentStates = activeStates.get(currentCharacterId) || new Set();
        for (let state in states) {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.id = state;
            checkbox.checked = currentStates.has(state);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    currentStates.add(state);
                } else {
                    currentStates.delete(state);
                }
                activeStates.set(currentCharacterId, currentStates);
                saveMemory();
                updateSystemPromptForCharacter(currentCharacterId);
            });

            const label = document.createElement("label");
            label.htmlFor = state;
            label.innerText = state;

            const container = document.createElement("div");
            container.className = "state-checkbox-container";
            container.appendChild(checkbox);
            container.appendChild(label);

            statesCheckboxesElement.appendChild(container);
        }

        customStateCheckbox.checked = currentStates.has('CustomState');
        customStateText.value = customStates[currentCharacterId] || '';
        customStateText.disabled = !customStateCheckbox.checked;

        customStateCheckbox.addEventListener('change', () => {
            if (customStateCheckbox.checked) {
                currentStates.add('CustomState');
                customStateText.disabled = false;
            } else {
                currentStates.delete('CustomState');
                customStateText.disabled = true;
            }
            activeStates.set(currentCharacterId, currentStates);
            saveMemory();
            updateSystemPromptForCharacter(currentCharacterId);
        });

        customStateText.addEventListener('input', (event) => {
            customStates[currentCharacterId] = event.target.value.trim();
            saveMemory();
            updateSystemPromptForCharacter(currentCharacterId);
        });
    }

    // Update settings UI when character changes
    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateSettingsUI();
    });

    // Initial update of the settings UI
    updateSettingsUI();
}
