import { eventSource, event_types, getContext } from "../../../script.js";

// Logging to confirm extension load
console.log("StateCoordinator extension loaded.");

const characterStates = {};

// Load state data
async function loadStateData(state) {
  try {
    console.log(`Attempting to load state data for: ${state}`);
    const response = await fetch(`./${state}.json`);
    if (!response.ok) throw new Error(`Failed to load ${state}.json`);
    const stateFile = await response.json();
    console.log(`Loaded state data for ${state}:`, stateFile);
    return stateFile;
  } catch (error) {
    console.error(`Error loading ${state}.json:`, error);
    return null;
  }
}

// Initialize states from states.json
let states = [];
async function initializeStates() {
  try {
    console.log("Attempting to load states.json");
    const response = await fetch('./states.json');
    if (!response.ok) throw new Error('Failed to load states.json');
    const stateData = await response.json();
    states = stateData.states;
    console.log("Loaded states:", states);
  } catch (error) {
    console.error("Error loading states.json:", error);
  }
}

// Update character state
function updateCharacterState(characterId, state, stateFile) {
  characterStates[characterId] = { state, stateFile };
  console.log(`Updated state for character ${characterId} to ${state}`);
}

// Clear character state
function clearCharacterState(characterId) {
  delete characterStates[characterId];
  console.log(`Cleared state for character ${characterId}`);
}

// Get character state
function getCharacterState(characterId) {
  return characterStates[characterId] || null;
}

// Modify prompt based on state
function modifyPrompt(prompt, characterId) {
  const stateInfo = getCharacterState(characterId);
  if (stateInfo) {
    return `${stateInfo.stateFile.stateMessage}\n${prompt}`;
  }
  return prompt;
}

// Check activation keywords
function checkActivationKeywords(input, stateFile) {
  return stateFile.activateKeywords.some(keyword => input.includes(keyword));
}

// Check deactivation keywords
function checkDeactivationKeywords(input, stateFile) {
  return stateFile.deactivateKeywords.some(keyword => input.includes(keyword));
}

// Handle user input
async function onUserInput(userInput, characterId) {
  console.log(`User input received: ${userInput}`);
  const currentState = getCharacterState(characterId);

  if (currentState) {
    if (checkDeactivationKeywords(userInput, currentState.stateFile)) {
      clearCharacterState(characterId);
      return `${currentState.stateFile.normalMessage}\n${userInput}`;
    }
  } else {
    for (const state of states) {
      const stateFile = await loadStateData(state);
      if (stateFile && checkActivationKeywords(userInput, stateFile)) {
        updateCharacterState(characterId, state, stateFile);
        return `${stateFile.stateMessage}\n${userInput}`;
      }
    }
  }

  return userInput;
}

// Handle character response
function onCharacterResponse(characterResponse, characterId) {
  console.log(`Character response received: ${characterResponse}`);
  return modifyPrompt(characterResponse, characterId);
}

// Register hooks
eventSource.on(event_types.MESSAGE_SENT, async (data) => {
  const context = getContext();
  if (context.characters.length > 0) {
    const characterId = context.characters[0].id;
    data.message = await onUserInput(data.message, characterId);
    console.log(`Processed user input: ${data.message}`);
  } else {
    console.error("No characters found in context.");
  }
});

eventSource.on(event_types.MESSAGE_RECEIVED, (data) => {
  const context = getContext();
  if (context.characters.length > 0) {
    const characterId = context.characters[0].id;
    data.message = onCharacterResponse(data.message, characterId);
    console.log(`Processed character response: ${data.message}`);
  } else {
    console.error("No characters found in context.");
  }
});

// Initialize states on load
initializeStates().then(() => {
  console.log("States initialized.");
});
