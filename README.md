# Biv Desktop AI

Biv is a minimal AI assistant that stays hidden on your desktop and appears with a hotkey. It supports local models via Ollama and cloud models via OpenRouter.

## Installation

1. Install [Node.js](https://nodejs.org/).
2. Run `npm install` in this folder.
3. Create .env file from .env.example.

## Quick Start (Windows)

Use these files to control the app without using the terminal:
- **Start_Biv.bat**: Run the app in the background.
- **Stop_Biv.bat**: Close the app.
- **Install_Startup.bat**: Run at Windows startup.
- **Uninstall_Startup.bat**: Remove from startup.

## Usage

- **Toggle Window**: Press `Ctrl + Shift + Space`.
- **Sidebars**: Icons in the bottom bar open your chat history (left) and settings (right).
- **Images**: Drag an image into the input or use the paperclip icon to analyze it.

## Settings & Configuration (.env)

All main application settings are stored in the **.env** file. You should edit this file to configure your experience:

- **OLLAMA_ENABLED**: Set to `true` to use local models.
- **OPENROUTER_API_KEY**: Paste your key for cloud models.
- **AI_PROVIDER**: Set your preferred default backend (`ollama` or `openrouter`).
- **OLLAMA_MODELS**: Define which local models appear in your list.
- **OPENROUTER_MODELS**: Define which cloud models appear in your list.

After making changes to the `.env` file, simply restart the application for them to take effect.

Open settings to change themes (Dark, Light, Transparent) or enable desktop notifications. You can also export your chats to a JSON file for backup.