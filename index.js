import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from "../../../../script.js";
import { getContext } from "../../../extensions.js";

const extensionPromptMarker = '___StateCoordinator___';
const extensionPromptRole = extension_prompt_roles.SYSTEM;  // Setting the role to 'system'
const extensionPromptPosition = extension_prompt_types.BEFORE_PROMPT;  // Position for the system prompt
const extensionPromptDepth = 1;  // Depth can be adjusted as needed

console.log('StateCoordinator: Launched');

const url = window.location.href;
const extension_url = url + "scripts/extensions/third-party/StateCoordinator/";
console.log('StateCoordinator: Extension URL', extension_url);

let states = {};
let activeStates = {};
let customState = ''; // To store the custom state prompt

// Load the states configuration
async function loadStatesConfig() {
    try {
        const response = await fetch(extension_url + 'states.json');
        const statesData = await response.json();
        for (let state of statesData.states) {
            const stateResponse = await fetch(extension_url + `${state}.json`);
            states[state] = await stateResponse.json();
        }
        console.log("StateCoordinator: Loaded states configuration", states);
    } catch (error) {
        console.error("StateCoordinator: Failed to load states configuration", error);
    }
}

async function onStateCoordinatorIntercept(chat) {
    // Retrieve application context, including chat logs and participant info.
    const context = getContext();

    // Find the latest user message and character ID
    let latestUserMessage = '';
    let characterId = '';

    for (let message of chat.slice().reverse()) {
        if (message.is_user) {
            latestUserMessage = message.mes;
            characterId = message.cid;
            break;
        }
    }

    if (!latestUserMessage) {
        console.log('StateCoordinator: No valid user message found.');
        return;
    }

    let currentStates = activeStates[characterId] || new Set();
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
                console.log(`StateCoordinator: Character ${characterId} exited state ${state}`);
                break;
            }
        }
    }

    // Remove states marked for removal
    for (let state of statesToRemove) {
        currentStates.delete(state);
        if (state === 'CustomState') {
            customState = ''; // Clear custom state
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
                    console.log(`StateCoordinator: Character ${characterId} entered state ${state}`);
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
            customState = match[1].trim();
            currentStates.add('CustomState');
            stateChanged = true;
            console.log(`StateCoordinator: Character ${characterId} entered CustomState with custom prompt: ${customState}`);
        }
    }

    // Check for custom state exit keyword
    if (latestUserMessage.includes('nocustomstate')) {
        modifiedMessage = modifiedMessage.replace('nocustomstate', '');
        currentStates.delete('CustomState');
        customState = '';
        stateChanged = true;
        console.log(`StateCoordinator: Character ${characterId} exited CustomState`);
    }

    // Add states marked for addition
    for (let state of statesToAdd) {
        currentStates.add(state);
    }

    // Update active states for the character
    if (currentStates.size > 0) {
        activeStates[characterId] = currentStates;
    } else {
        delete activeStates[characterId];
    }

    // Construct the final state prompt for all current states
    let finalStatePrompt = '';
    for (let state of currentStates) {
        if (state === 'CustomState') {
            finalStatePrompt += `${customState}\n`;
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

// Assign the interceptor function to be used
window['StateCoordinator_Intercept'] = onStateCoordinatorIntercept;
