# State Coordinator

State Coordinator is a native SillyTavern extension for deterministic story-state and continuity guidance. It keeps persistent constraints scoped to each chat and can also guide a single response without adding an out-of-character message to chat history.

## Features

- Persistent states with editable prompts and enter/exit commands
- State storage scoped per chat, including group chats
- Free-form custom state per chat
- One-shot **Guide next response** action beside the composer
- Configurable injection role, position, and depth
- Optional case-sensitive matching and command removal
- Active-state chips beside the composer
- JSON import/export
- Migration of settings from the original State Coordinator release
- Legacy `states/<name>.json` catalogs remain supported

## Install

In SillyTavern, open **Extensions → Install Extension** and enter:

`https://github.com/venom8898/StateCoordinator`

## Use

Open **Extensions → State Coordinator** to create or edit states. Each state can have:

- a prompt injected while the state is active;
- one or more comma-separated enter commands;
- one or more comma-separated exit commands.

For example, the bundled **Injured** state uses `/injured` and `/recovered`. When command removal is enabled, those markers affect state but are removed before the model sees the user message.

To guide only the next response, type an instruction in the normal composer and click the compass button. The guidance is cleared after that generation.

Use `/state custom <text>` to set chat-specific custom state, or `/state custom clear` to remove it.

## State file format

`states.json` accepts inline definitions:

```json
{
  "states": [
    {
      "id": "injured",
      "name": "Injured",
      "prompt": "Preserve established injuries and limitations.",
      "enter": ["/injured"],
      "exit": ["/recovered"],
      "enabled": true
    }
  ]
}
```

The original format—state names in `states.json` with definitions in `states/<name>.json`—is also loaded and migrated automatically.
