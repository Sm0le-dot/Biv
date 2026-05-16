const { ipcRenderer } = require('electron');
const fs = require('fs');
const https = require('https');
const path = require('path');

const input = document.getElementById('ai-input');
const send_button = document.getElementById('send-button');
const container = document.getElementById('container');

/** @type {string[]} data URLs of images queued for the next send */
let pendingImages = [];

// Backends: Ollama (local) and OpenRouter together in one model picker.
// Model catalogs: JSON arrays in .env keys OLLAMA_MODELS and OPENROUTER_MODELS.
const ENV_FILE = path.join(__dirname, '..', '.env');
const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';
const DEFAULT_AI_PROVIDER = 'ollama';

/** Parsed from .env (`OLLAMA_MODELS` JSON). */
let OLLAMA_MODELS = [];

/** Parsed from .env (`OPENROUTER_MODELS` JSON). */
let OPENROUTER_MODELS = [];

let OLLAMA_BASE_URL = DEFAULT_OLLAMA_BASE;
let OLLAMA_ENABLED = true;
let OPENROUTER_ENABLED = true;

/** @type {'ollama'|'openrouter'} */
let AI_PROVIDER = DEFAULT_AI_PROVIDER;
let OPENROUTER_API_KEY = '';
let allModels = [];
let currentModelKey = '';
let currentAbortController = null;

function trimEnvValue(s) {
    return s.trim().replace(/^["'](.*)["']$/, '$1');
}

/** Strip whitespace and optional one pair of wrapping quotes around a JSON blob. */
function trimEnvJsonBlob(s) {
    let t = String(s || '').trim();
    while (
        t.length >= 2 &&
        ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    ) {
        t = t.slice(1, -1).trim();
    }
    return t;
}

function parseEnvBool(value, fallback = true) {
    const v = String(value || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
}

/** @param {string} val Raw JSON array: [{"id":"...","name":"...","vision":false}, ...] */
function parseModelsEnvJson(val) {
    const s = String(val || '').trim();
    if (!s) return [];
    try {
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item) => item && typeof item.id === 'string' && item.id.trim())
            .map((item) => ({
                id: item.id.trim(),
                name:
                    typeof item.name === 'string' && item.name.trim()
                        ? item.name.trim()
                        : item.id.trim(),
                vision: !!item.vision
            }));
    } catch (e) {
        console.error('Invalid OLLAMA_MODELS / OPENROUTER_MODELS JSON:', e.message);
        return [];
    }
}

let rawOllamaModelsJson = '';
let rawOpenRouterModelsJson = '';

/**
 * Reads a JSON array value that may span multiple lines in `.env`.
 * Stops when `JSON.parse` succeeds or the next line starts a new `KEY=`.
 */
function readModelsJsonBlob(lines, startLineIndex, firstLineAfterEquals) {
    let blob = trimEnvJsonBlob(firstLineAfterEquals);
    let j = startLineIndex + 1;
    while (j < lines.length) {
        try {
            const parsed = JSON.parse(blob.replace(/\r/g, '').trim());
            if (Array.isArray(parsed)) break;
        } catch {
            /* keep accumulating */
        }
        const next = lines[j];
        if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(next)) break;
        blob += String(next).trim();
        j++;
    }
    return { blob, nextLineIndex: j };
}

try {
    if (fs.existsSync(ENV_FILE)) {
        const envContent = fs.readFileSync(ENV_FILE, 'utf8');
        const envLines = envContent.split(/\r?\n/);
        for (let lineIdx = 0; lineIdx < envLines.length; lineIdx++) {
            const line = envLines[lineIdx];
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (!m) continue;
            const key = m[1];
            const rawLine = m[2];
            const val = trimEnvValue(rawLine);
            if (key === 'OLLAMA_MODELS' || key === 'OPENROUTER_MODELS') {
                const { blob, nextLineIndex } = readModelsJsonBlob(envLines, lineIdx, rawLine);
                if (key === 'OLLAMA_MODELS') rawOllamaModelsJson = blob;
                else rawOpenRouterModelsJson = blob;
                lineIdx = nextLineIndex - 1;
                continue;
            }
            if (key === 'OLLAMA_BASE_URL' && val) OLLAMA_BASE_URL = val.replace(/\/+$/, '');
            if (key === 'OLLAMA_ENABLED') OLLAMA_ENABLED = parseEnvBool(val, true);
            if (key === 'AI_PROVIDER' && val) {
                const p = val.toLowerCase();
                if (p === 'openrouter' || p === 'ollama') AI_PROVIDER = p;
                if (p === 'openai') AI_PROVIDER = 'openrouter';
            }
            if (key === 'OPENROUTER_ENABLED') OPENROUTER_ENABLED = parseEnvBool(val, true);
            if (key === 'OPENROUTER_API_KEY' && val) OPENROUTER_API_KEY = val;
            // Backward-compatible aliases
            if (key === 'OPENAI_API_KEY' && val && !OPENROUTER_API_KEY) OPENROUTER_API_KEY = val;
        }
    }
} catch (e) {
    console.error('Error loading .env file:', e);
}

OLLAMA_MODELS = parseModelsEnvJson(rawOllamaModelsJson);
OPENROUTER_MODELS = parseModelsEnvJson(rawOpenRouterModelsJson);

function toModelKey(backend, modelId) {
    return `${backend}:${modelId}`;
}

function parseModelKey(modelKey) {
    const idx = modelKey.indexOf(':');
    if (idx <= 0) return null;
    const backend = modelKey.slice(0, idx);
    const modelId = modelKey.slice(idx + 1);
    if ((backend !== 'ollama' && backend !== 'openrouter') || !modelId) return null;
    return { backend, modelId };
}

function buildModelCatalog() {
    const map = new Map();
    const add = (backend, model) => {
        const key = toModelKey(backend, model.id);
        if (map.has(key)) return;
        map.set(key, {
            key,
            backend,
            id: model.id,
            name: model.name,
            vision: !!model.vision
        });
    };

    if (OLLAMA_ENABLED) {
        for (const model of OLLAMA_MODELS) add('ollama', model);
    }
    if (OPENROUTER_ENABLED) {
        for (const model of OPENROUTER_MODELS) add('openrouter', model);
    }

    return Array.from(map.values());
}

allModels = buildModelCatalog();

function modelByKey(modelKey) {
    return allModels.find((m) => m.key === modelKey) || null;
}

function firstModelByBackend(backend) {
    return allModels.find((m) => m.backend === backend) || null;
}

function pickInitialModelKey() {
    const preferredBackendAny = firstModelByBackend(AI_PROVIDER);
    if (preferredBackendAny) return preferredBackendAny.key;

    return allModels.length ? allModels[0].key : '';
}
currentModelKey = pickInitialModelKey();

function ollamaChatUrl() {
    return `${OLLAMA_BASE_URL}/api/chat`;
}

async function refreshOllamaBanner() {
    const banner = document.getElementById('ollama-missing-banner');
    if (!banner) return;
    const winDl = document.getElementById('ollama-btn-download-win');
    if (winDl) {
        winDl.style.display = process.platform === 'win32' ? 'inline-flex' : 'none';
    }
    const needsOllama = OLLAMA_ENABLED && OLLAMA_MODELS.length > 0;
    if (!needsOllama) {
        banner.style.display = 'none';
        container.classList.remove('has-ollama-banner');
        return;
    }
    try {
        const ok = await ipcRenderer.invoke('ollama-probe', OLLAMA_BASE_URL);
        const show = !ok;
        banner.style.display = show ? 'flex' : 'none';
        container.classList.toggle('has-ollama-banner', show);
    } catch (_) {
        banner.style.display = 'flex';
        container.classList.add('has-ollama-banner');
    }
}

function setupOllamaMissingBanner() {
    const pageBtn = document.getElementById('ollama-btn-download-page');
    const winBtn = document.getElementById('ollama-btn-download-win');
    const startBgBtn = document.getElementById('ollama-btn-start-bg');
    const retryBtn = document.getElementById('ollama-btn-retry');
    if (pageBtn) {
        pageBtn.onclick = async (e) => {
            e.stopPropagation();
            await ipcRenderer.invoke('ollama-open-download-page');
        };
    }
    if (winBtn) {
        winBtn.onclick = async (e) => {
            e.stopPropagation();
            winBtn.disabled = true;
            const prev = winBtn.textContent;
            winBtn.textContent = 'Downloading…';
            try {
                const r = await ipcRenderer.invoke('ollama-download-windows-installer');
                if (!r.ok && r.reason) {
                    console.warn('Ollama installer:', r.reason);
                }
            } finally {
                winBtn.disabled = false;
                winBtn.textContent = prev;
                await refreshOllamaBanner();
            }
        };
    }
    if (startBgBtn) {
        startBgBtn.onclick = async (e) => {
            e.stopPropagation();
            startBgBtn.disabled = true;
            const prev = startBgBtn.textContent;
            startBgBtn.textContent = 'Starting…';
            try {
                const r = await ipcRenderer.invoke('ollama-try-start-background', OLLAMA_BASE_URL);
                if (!r.ok && r.reason) {
                    console.warn('Start Ollama:', r.reason);
                }
            } finally {
                startBgBtn.disabled = false;
                startBgBtn.textContent = prev;
                await refreshOllamaBanner();
            }
        };
    }
    if (retryBtn) {
        retryBtn.onclick = async (e) => {
            e.stopPropagation();
            await refreshOllamaBanner();
        };
    }
}

function updateModelBadge() {
    const nameEl = document.getElementById('current-model-name');
    const selected = modelByKey(currentModelKey);
    const backend = selected ? (selected.backend === 'openrouter' ? 'OpenRouter' : 'Ollama') : 'Model';
    const label = selected ? selected.name : 'No model';
    if (nameEl) nameEl.textContent = `${backend} · ${label}`;
}

function renderModelList() {
    const list = document.getElementById('model-list');
    if (!list) return;
    list.innerHTML = '';
    if (allModels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-item';
        empty.textContent = 'No models — set OLLAMA_MODELS / OPENROUTER_MODELS in .env';
        list.appendChild(empty);
        return;
    }
    for (const model of allModels) {
        const div = document.createElement('div');
        div.className = `model-item ${model.key === currentModelKey ? 'active' : ''}`;
        const prefix = model.backend === 'openrouter' ? 'OpenRouter' : 'Ollama';
        div.textContent = `${prefix} · ${model.name}`;
        div.onclick = (e) => {
            e.stopPropagation();
            selectModel(model.key);
        };
        list.appendChild(div);
    }
}

function selectModel(modelKey) {
    const picked = modelByKey(modelKey);
    if (!picked) return;
    currentModelKey = modelKey;
    const list = document.getElementById('model-list');
    if (list) list.classList.remove('visible');
    updateModelBadge();
    renderModelList();
}

function toggleModelList() {
    const list = document.getElementById('model-list');
    if (list) list.classList.toggle('visible');
}

function hasImageInUserContent(content) {
    if (typeof content === 'string') return false;
    if (!Array.isArray(content)) return false;
    return content.some((p) => p.type === 'image_url' && p.image_url && p.image_url.url);
}

function chatHasAnyImages(messages) {
    return messages.some((m) => m.role === 'user' && hasImageInUserContent(m.content));
}

function currentModelSupportsVision() {
    const selected = modelByKey(currentModelKey);
    return !!(selected && selected.vision);
}

/** Use a vision model from same backend when needed. */
function effectiveModelForChat(messages) {
    const selected = modelByKey(currentModelKey);
    if (!selected) return null;
    if (!chatHasAnyImages(messages)) return selected;
    if (currentModelSupportsVision()) return selected;
    const fallbackVision = allModels.find((m) => m.backend === selected.backend && m.vision);
    return fallbackVision || selected;
}

function autoSwitchToVisionModel() {
    const selected = modelByKey(currentModelKey);
    // If current model already supports vision, no need to switch
    if (selected && selected.vision) return;

    // Try to find a vision model in the SAME backend first
    let visionModel = null;
    if (selected) {
        visionModel = allModels.find(m => m.backend === selected.backend && m.vision);
    }

    // If not found in same backend, try to find ANY vision model
    if (!visionModel) {
        visionModel = allModels.find(m => m.vision);
    }

    if (visionModel && visionModel.key !== currentModelKey) {
        console.log(`Auto-switching to vision model: ${visionModel.name}`);
        selectModel(visionModel.key);
    }
}

/** Ollama expects user turns as { role, content, images?: base64[] } */
function userContentToOllamaMessage(content) {
    const normalized = normalizeUserContentForApi(content);
    if (typeof normalized === 'string') {
        return { role: 'user', content: normalized };
    }
    if (!Array.isArray(normalized)) {
        return { role: 'user', content: String(normalized) };
    }
    let text = '';
    const images = [];
    for (const p of normalized) {
        if (p.type === 'text') text += p.text || '';
        if (p.type === 'image_url' && p.image_url && p.image_url.url) {
            const url = p.image_url.url;
            const data = /^data:image\/\w+;base64,(.+)$/i.exec(url);
            if (data) images.push(data[1]);
        }
    }
    const msg = { role: 'user', content: text.trim() || (images.length ? '(see image)' : '') };
    if (images.length) msg.images = images;
    return msg;
}

function buildOllamaMessages(systemContent, messages) {
    const out = [{ role: 'system', content: systemContent }];
    for (const m of messages) {
        if (m.role === 'assistant') {
            const c = typeof m.content === 'string' ? m.content : String(m.content ?? '');
            out.push({ role: 'assistant', content: c });
        } else if (m.role === 'user') {
            out.push(userContentToOllamaMessage(m.content));
        }
    }
    return out;
}

function buildOpenRouterMessages(systemContent, messages) {
    const out = [{ role: 'system', content: systemContent }];
    for (const m of messages) {
        if (m.role === 'assistant') {
            const c = typeof m.content === 'string' ? m.content : String(m.content ?? '');
            out.push({ role: 'assistant', content: c });
        } else if (m.role === 'user') {
            const normalized = normalizeUserContentForApi(m.content);
            out.push({ role: 'user', content: normalized });
        }
    }
    return out;
}

/** Node https avoids browser CORS when calling openrouter.ai from the Electron renderer. */
function openrouterChatCompletionsRequest(bodyObject, signal) {
    const payload = JSON.stringify(bodyObject);
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'openrouter.ai',
                port: 443,
                path: '/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'https://localhost',
                    'X-Title': 'Desktop LLM',
                    'Content-Length': Buffer.byteLength(payload, 'utf8')
                }
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try {
                        json = JSON.parse(raw);
                    } catch (_) {
                        json = null;
                    }
                    resolve({ statusCode: res.statusCode || 0, json, raw });
                });
            }
        );

        if (signal) {
            signal.addEventListener('abort', () => {
                req.destroy();
                reject(new Error('Aborted'));
            });
        }

        req.on('error', (err) => {
            if (err.message === 'Aborted') return;
            reject(err);
        });
        req.write(payload, 'utf8');
        req.end();
    });
}

function modelDisplayName(modelKey) {
    const meta = modelByKey(modelKey);
    return meta ? meta.name : modelKey;
}

/**
 * @returns {Promise<{ ok: boolean, assistantText?: string, errorText?: string, modelForRequestKey: string, modelSwitchedForVision: boolean }>}
 */
/**
 * @returns {Promise<{ ok: boolean, assistantText?: string, errorText?: string, modelForRequestKey: string, modelSwitchedForVision: boolean }>}
 */
async function requestAssistantFromBackend(systemPrompt, chatMessages, signal) {
    const selected = modelByKey(currentModelKey);
    if (!selected) {
        return {
            ok: false,
            errorText: 'No model selected.',
            modelForRequestKey: currentModelKey,
            modelSwitchedForVision: false
        };
    }
    const effectiveModel = effectiveModelForChat(chatMessages);
    if (!effectiveModel) {
        return {
            ok: false,
            errorText: 'No model available for this request.',
            modelForRequestKey: currentModelKey,
            modelSwitchedForVision: false
        };
    }
    const modelSwitchedForVision =
        chatHasAnyImages(chatMessages) &&
        effectiveModel.key !== selected.key &&
        !selected.vision;

    if (effectiveModel.backend === 'openrouter') {
        if (!OPENROUTER_API_KEY || !OPENROUTER_API_KEY.trim()) {
            return {
                ok: false,
                errorText:
                    'OpenRouter API key missing. Set `OPENROUTER_API_KEY` in `.env`.',
                modelForRequestKey: effectiveModel.key,
                modelSwitchedForVision: false
            };
        }
        const openrouterMessages = buildOpenRouterMessages(systemPrompt, chatMessages);
        const { statusCode, json } = await openrouterChatCompletionsRequest({
            model: effectiveModel.id,
            messages: openrouterMessages,
            stream: false
        }, signal);
        const choice = json && json.choices && json.choices[0];
        const msg = choice && choice.message;
        const content = msg && typeof msg.content === 'string' ? msg.content : '';
        if (content.trim()) {
            return { ok: true, assistantText: content, modelForRequestKey: effectiveModel.key, modelSwitchedForVision };
        }
        const apiErr = json && json.error;
        const errText = apiErr
            ? typeof apiErr === 'string'
                ? apiErr
                : apiErr.message || JSON.stringify(apiErr)
            : statusCode
                ? `HTTP ${statusCode}`
                : 'Empty or invalid response';
        return { ok: false, errorText: errText, modelForRequestKey: effectiveModel.key, modelSwitchedForVision };
    }

    const ollamaMessages = buildOllamaMessages(systemPrompt, chatMessages);
    const response = await fetch(ollamaChatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: effectiveModel.id,
            messages: ollamaMessages,
            stream: false
        }),
        signal
    });
    let data = {};
    try {
        data = await response.json();
    } catch (_) {
        data = {};
    }
    const ollamaMsg = data.message;
    const hasReply =
        ollamaMsg && typeof ollamaMsg.content === 'string' && ollamaMsg.role === 'assistant';
    if (hasReply) {
        const text = ollamaMsg.content.trim()
            ? ollamaMsg.content
            : '_(The model returned an empty reply.)_';
        return { ok: true, assistantText: text, modelForRequestKey: effectiveModel.key, modelSwitchedForVision };
    }
    if (data.error) {
        const apiErr = data.error;
        const errText =
            typeof apiErr === 'string' ? apiErr : apiErr.message || JSON.stringify(apiErr);
        return { ok: false, errorText: errText, modelForRequestKey: effectiveModel.key, modelSwitchedForVision };
    }
    if (!response.ok) {
        const errText = data.message || data.error || `HTTP ${response.status}`;
        return { ok: false, errorText: errText, modelForRequestKey: effectiveModel.key, modelSwitchedForVision };
    }
    return {
        ok: false,
        errorText: 'The API did not return a reply. Check the console for details.',
        modelForRequestKey: effectiveModel.key,
        modelSwitchedForVision
    };
}

// Chat storage logic
const CHATS_FILE = path.join(__dirname, '..', 'data', 'chats.json');
let chats = [];
let currentChatId = null;

function loadChats() {
    try {
        if (fs.existsSync(CHATS_FILE)) {
            const data = fs.readFileSync(CHATS_FILE, 'utf8');
            chats = JSON.parse(data);
        }
    } catch (e) {
        console.error("Error loading chats:", e);
    }
    renderChatList();
}

function saveChats() {
    try {
        fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2));
    } catch (e) {
        console.error("Error saving chats:", e);
    }
}

function createNewChat() {
    currentChatId = Date.now().toString();
    chats.unshift({
        id: currentChatId,
        title: "New Chat",
        messages: []
    });
    saveChats();
    renderChatList();

    // Clear UI
    document.getElementById('aiOutput').innerHTML = '';
    clearImages();
    resetThinkingState();
    const outputContainer = document.querySelector('.ai_output_container');
    if (outputContainer) {
        outputContainer.classList.remove('visible');
    }
}

function switchChat(id) {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
    currentChatId = id;
    renderChatList();

    // Render messages
    const aiOutput = document.getElementById('aiOutput');
    aiOutput.innerHTML = '';

    const chat = chats.find(c => c.id === id);
    if (chat && chat.messages.length > 0) {
        const outputContainer = document.querySelector('.ai_output_container');
        if (outputContainer && !outputContainer.classList.contains('visible')) {
            outputContainer.classList.add('visible');
        }

        for (const msg of chat.messages) {
            const div = document.createElement('div');
            div.className = `message ${msg.role}`;

            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            if (msg.role === 'user') {
                populateUserMessageContent(contentDiv, msg.content);
            } else {
                contentDiv.innerHTML = parseMarkdown(msg.content);
            }
            div.appendChild(contentDiv);

            aiOutput.appendChild(div);
        }
        aiOutput.parentElement.scrollTop = aiOutput.parentElement.scrollHeight;
    } else {
        const outputContainer = document.querySelector('.ai_output_container');
        if (outputContainer) {
            outputContainer.classList.remove('visible');
        }
    }
}

function deleteChat(e, id) {
    e.stopPropagation(); // Prevent switching
    chats = chats.filter(c => c.id !== id);
    if (currentChatId === id) {
        if (chats.length > 0) {
            switchChat(chats[0].id);
        } else {
            createNewChat();
        }
    } else {
        saveChats();
        renderChatList();
    }
}

function removeMessageAbortButtons() {
    document.querySelectorAll('.message-abort-btn').forEach(btn => btn.remove());
}

function resetThinkingState() {
    // Just call abortRequest. It already handles everything.
    abortRequest();
}

function abortRequest() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;

        const aiOutput = document.getElementById('aiOutput');
        // Find the last user message element in the UI
        const messages = aiOutput.querySelectorAll('.message.user');
        const lastUserMsg = messages[messages.length - 1];

        if (lastUserMsg) {
            lastUserMsg.classList.add('abort');
            // change the text to indicate it was aborted
            const contentDiv = lastUserMsg.querySelector('.message-content');
            if (contentDiv) {
                contentDiv.innerHTML += ' <span class="abort-text">(Aborted)</span>';
            }
        }

        // Update the data structure so it persists
        const chat = chats.find(c => c.id === currentChatId);
        if (chat && chat.messages.length > 0) {
            const lastDataMsg = chat.messages[chat.messages.length - 1];
            if (lastDataMsg.role === 'user') {
                // Append "(Aborted)" to the actual message content
                if (typeof lastDataMsg.content === 'string') {
                    lastDataMsg.content += ' (Aborted)';
                } else if (Array.isArray(lastDataMsg.content)) {
                    // For content arrays, append to the text part
                    const textPart = lastDataMsg.content.find(p => p.type === 'text');
                    if (textPart) {
                        textPart.text = (textPart.text || '') + ' (Aborted)';
                    } else {
                        lastDataMsg.content.push({ type: 'text', text: '(Aborted)' });
                    }
                }
            }
            saveChats();
        }
    }

    // Reset UI State
    send_button.disabled = false;
    send_button.classList.remove('disabled');
    input.placeholder = "Ask anything…";
    input.classList.remove('thinking');
    removeMessageAbortButtons();
}

function renameChat(e, id, titleDiv, actionsDiv, div) {
    e.stopPropagation();

    // prevent switching while editing
    div.onclick = (ev) => ev.stopPropagation();

    const input = document.createElement('input');
    input.type = 'text';
    input.value = titleDiv.innerText;
    input.className = 'chat-item-rename-input';

    titleDiv.style.display = 'none';
    actionsDiv.style.display = 'none';

    div.insertBefore(input, actionsDiv);
    input.focus();

    const finishEdit = () => {
        const newName = input.value.trim();
        if (newName !== "") {
            const chat = chats.find(c => c.id === id);
            if (chat) {
                chat.title = newName;
                saveChats();
            }
        }
        renderChatList();
    };

    input.onblur = finishEdit;
    input.onkeydown = (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            input.blur();
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            input.value = titleDiv.innerText; // revert
            input.blur();
        }
    };
}

function renderChatList() {
    const list = document.getElementById('chat-list');
    list.innerHTML = '';

    for (const chat of chats) {
        const div = document.createElement('div');
        div.className = `chat-item ${chat.id === currentChatId ? 'active' : ''}`;
        div.onclick = () => switchChat(chat.id);

        const titleDiv = document.createElement('div');
        titleDiv.className = 'chat-item-title';
        titleDiv.innerText = chat.title;
        div.appendChild(titleDiv);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'chat-item-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'chat-item-btn';
        renameBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
        renameBtn.onclick = (e) => renameChat(e, chat.id, titleDiv, actionsDiv, div);
        actionsDiv.appendChild(renameBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'chat-item-btn delete-btn';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.onclick = (e) => deleteChat(e, chat.id);
        actionsDiv.appendChild(delBtn);

        div.appendChild(actionsDiv);
        list.appendChild(div);
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('visible')) {
        sidebar.classList.remove('visible');
    } else {
        sidebar.classList.add('visible');
    }
}

// Listen for window-shown event from main process
ipcRenderer.on('window-shown', () => {
    const outputContainer = document.querySelector('.ai_output_container');
    const hasMessages = document.getElementById('aiOutput').children.length > 0;

    // 1. Clear any existing state
    container.classList.remove('animate-in');
    if (hasMessages && outputContainer) {
        outputContainer.classList.remove('visible');
    }

    // 2. Force reflow
    void container.offsetWidth;
    if (hasMessages && outputContainer) {
        void outputContainer.offsetWidth;
    }

    // 3. Restart animation
    container.classList.add('animate-in');
    if (hasMessages && outputContainer) {
        outputContainer.classList.add('visible');
    }

    input.focus();
    refreshOllamaBanner();
});

// Auto-expand textarea height based on content
function autoExpand() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

input.addEventListener('input', autoExpand);

function renderImagePreviews() {
    const wrap = document.getElementById('image-preview-wrapper');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (pendingImages.length === 0) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'flex';
    pendingImages.forEach((dataUrl, index) => {
        const item = document.createElement('div');
        item.className = 'preview-item';
        
        const img = document.createElement('img');
        img.src = dataUrl;
        item.appendChild(img);
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
        removeBtn.onclick = () => removeImage(index);
        item.appendChild(removeBtn);
        
        wrap.appendChild(item);
    });
}

function removeImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreviews();
}

function clearImages() {
    pendingImages = [];
    renderImagePreviews();
    const fileInput = document.getElementById('file-input');
    if (fileInput) fileInput.value = '';
}

function handleFileSelect(event) {
    const files = event.target?.files;
    if (!files || files.length === 0) return;
    
    Array.from(files).forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
            pendingImages.push(reader.result);
            renderImagePreviews();
            autoSwitchToVisionModel();
        };
        reader.readAsDataURL(file);
    });
}

function addImageFromBlob(blob) {
    if (!blob || !blob.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
        pendingImages.push(reader.result);
        renderImagePreviews();
        autoSwitchToVisionModel();
    };
    reader.readAsDataURL(blob);
}

function buildUserMessageContent(text, images) {
    const t = text.trim();
    if (!images || images.length === 0) return t;
    const content = [{ type: 'text', text: t || (images.length > 0 ? '(Sent images)' : '') }];
    images.forEach(dataUrl => {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
    });
    return content;
}

function populateUserMessageContent(element, content) {
    element.innerHTML = '';
    if (typeof content === 'string') {
        element.innerHTML = parseMarkdown(content);
        return;
    }
    if (!Array.isArray(content)) return;
    for (const part of content) {
        if (part.type === 'text' && (part.text || '').trim()) {
            const textWrap = document.createElement('div');
            textWrap.innerHTML = parseMarkdown(part.text);
            element.appendChild(textWrap);
        } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
            const url = part.image_url.url;
            if (!/^data:image\//i.test(url) && !/^https?:\/\//i.test(url)) continue;
            const img = document.createElement('img');
            img.className = 'message-inline-image';
            img.src = url;
            img.alt = 'Attached image';
            element.appendChild(img);
        }
    }
}

function messageTitleSource(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const text = content
            .filter((p) => p.type === 'text')
            .map((p) => p.text || '')
            .join(' ')
            .trim();
        return text || 'Image';
    }
    return '';
}

/** Some vision APIs reject all-image user turns; add a minimal text part only for the request. */
function normalizeUserContentForApi(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content;
    let parts = content.filter((p) => {
        if (p.type === 'text') return (p.text || '').trim().length > 0;
        if (p.type === 'image_url') return !!(p.image_url && p.image_url.url);
        return false;
    });
    const hasImage = parts.some((p) => p.type === 'image_url');
    const hasText = parts.some((p) => p.type === 'text');
    if (hasImage && !hasText) {
        parts = [{ type: 'text', text: 'Answer based on the attached image.' }, ...parts];
    }
    return parts;
}

input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
            e.preventDefault();
            const blob = item.getAsFile();
            if (blob) addImageFromBlob(blob);
        }
    }
});

// Check if scrollbar is active and update button class
function checkScrollbar() {
    if (input.scrollHeight > input.clientHeight) {
        send_button.classList.add('scroll');
    } else {
        send_button.classList.remove('scroll');
    }
}

input.addEventListener('input', checkScrollbar);
window.addEventListener('resize', checkScrollbar);

// Parse markdown and convert to HTML
function parseMarkdown(text) {
    let html = text;

    html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');

    html = html.replace(/```\w*\n([\s\S]*?)```/g, '<div class="code-block-wrapper"><button class="copy-btn code-copy" onclick="copyCode(this)"><i class="fa-solid fa-copy"></i></button><pre><code>$1</code></pre></div>');
    html = html.replace(/```([\s\S]*?)```/g, '<div class="code-block-wrapper"><button class="copy-btn code-copy" onclick="copyCode(this)"><i class="fa-solid fa-copy"></i></button><pre><code>$1</code></pre></div>');

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\n/g, '<br>');

    return html;
}

// Smooth typing animation
async function typeMessage(element, text, speed = 2, signal) {
    return new Promise((resolve) => {
        let index = 0;
        const htmlText = parseMarkdown(text);
        element.innerHTML = '';

        function type() {
            if (index < htmlText.length) {
                if (htmlText.charAt(index) === '<') {
                    const tagEnd = htmlText.indexOf('>', index);
                    if (tagEnd !== -1) {
                        index = tagEnd + 1;
                    } else {
                        index++;
                    }
                } else {
                    index++;
                }

                element.innerHTML = htmlText.substring(0, index);

                const container = document.querySelector('.ai_output_container');
                if (container) {
                    container.scrollTop = container.scrollHeight;
                }

                if (signal && signal.aborted) {
                    resolve();
                    return;
                }
                setTimeout(type, speed);
            } else {
                resolve();
            }
        }
        type();
    });
}
    
// ============ CLOCK WIDGET LOGIC ============

const clockWidget = document.getElementById('clock-widget');
const clockTabs = document.querySelectorAll('.clock-tab');
const tabPanes = document.querySelectorAll('.tab-pane');

// Clock Tab
const digitalClock = document.getElementById('digital-clock');
const dateDisplay = document.getElementById('date-display');

function updateClock() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    if (digitalClock) digitalClock.textContent = `${hours}:${minutes}:${seconds}`;
    
    if (dateDisplay) {
        const options = { weekday: 'long', month: 'long', day: 'numeric' };
        dateDisplay.textContent = now.toLocaleDateString(undefined, options);
    }
}

setInterval(updateClock, 1000);
updateClock();

// Tab Switching
clockTabs.forEach(tab => {
    tab.onclick = () => {
        const target = tab.getAttribute('data-tab');
        
        clockTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        tabPanes.forEach(pane => {
            pane.classList.remove('active');
            if (pane.id === `tab-${target}`) {
                pane.classList.add('active');
            }
        });
    };
});

let clockCloseTimeout = null;

function toggleClock(tabName = 'clock') {
    if (!clockWidget) return;
    if (clockWidget.classList.contains('visible')) {
        closeClock();
    } else {
        openClock(tabName);
    }
}

function openClock(tabName = 'clock') {
    if (!clockWidget) return;
    
    // Clear any pending close timeout
    if (clockCloseTimeout) {
        clearTimeout(clockCloseTimeout);
        clockCloseTimeout = null;
    }
    
    clockWidget.style.display = 'flex';
    // Small delay to ensure display:flex is applied before transition
    requestAnimationFrame(() => {
        clockWidget.classList.add('visible');
    });
    
    const tab = Array.from(clockTabs).find(t => t.getAttribute('data-tab') === tabName);
    if (tab) tab.click();
}

function closeClock() {
    if (!clockWidget) return;
    
    clockWidget.classList.remove('visible');
    
    // Clear any existing timeout before setting a new one
    if (clockCloseTimeout) clearTimeout(clockCloseTimeout);
    
    clockCloseTimeout = setTimeout(() => {
        clockWidget.style.display = 'none';
        clockCloseTimeout = null;
    }, 500);
}

// Stopwatch Logic
let stopwatchInterval = null;
let stopwatchTime = 0; // in milliseconds
const stopwatchDisplay = document.getElementById('stopwatch-display');
const stopwatchStartBtn = document.getElementById('stopwatch-start');
const stopwatchLapBtn = document.getElementById('stopwatch-lap');
const stopwatchResetBtn = document.getElementById('stopwatch-reset');
const stopwatchLaps = document.getElementById('stopwatch-laps');

function formatStopwatch(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const centiseconds = Math.floor((ms % 1000) / 10);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

if (stopwatchStartBtn) {
    stopwatchStartBtn.onclick = () => {
        if (stopwatchInterval) {
            // Stop
            clearInterval(stopwatchInterval);
            stopwatchInterval = null;
            stopwatchStartBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            stopwatchStartBtn.classList.remove('running');
        } else {
            // Start
            const startTime = Date.now() - stopwatchTime;
            stopwatchInterval = setInterval(() => {
                stopwatchTime = Date.now() - startTime;
                stopwatchDisplay.textContent = formatStopwatch(stopwatchTime);
            }, 10);
            stopwatchStartBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            stopwatchStartBtn.classList.add('running');
        }
    };
}

if (stopwatchLapBtn) {
    stopwatchLapBtn.onclick = () => {
        if (stopwatchTime === 0) return;
        const lapDiv = document.createElement('div');
        lapDiv.className = 'lap-item';
        lapDiv.innerHTML = `<span>Lap ${stopwatchLaps.children.length + 1}</span><span>${formatStopwatch(stopwatchTime)}</span>`;
        stopwatchLaps.prepend(lapDiv);
    };
}

if (stopwatchResetBtn) {
    stopwatchResetBtn.onclick = () => {
        clearInterval(stopwatchInterval);
        stopwatchInterval = null;
        stopwatchTime = 0;
        stopwatchDisplay.textContent = '00:00.00';
        stopwatchStartBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        stopwatchStartBtn.classList.remove('running');
        stopwatchLaps.innerHTML = '';
    };
}

// Timer Logic
let timerInterval = null;
let timerTotalSeconds = 0;
const timerDisplay = document.getElementById('timer-display');
const timerStartBtn = document.getElementById('timer-start');
const timerResetBtn = document.getElementById('timer-reset');
const timerMinInput = document.getElementById('timer-min');
const timerSecInput = document.getElementById('timer-sec');
const timerSetBtn = document.getElementById('timer-set');

function formatTimer(totalSecs) {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateTimerDisplay() {
    timerDisplay.textContent = formatTimer(timerTotalSeconds);
}

if (timerSetBtn) {
    timerSetBtn.onclick = () => {
        const mins = parseInt(timerMinInput.value) || 0;
        const secs = parseInt(timerSecInput.value) || 0;
        timerTotalSeconds = (mins * 60) + secs;
        updateTimerDisplay();
    };
}

if (timerStartBtn) {
    timerStartBtn.onclick = () => {
        if (timerInterval) {
            // Pause
            clearInterval(timerInterval);
            timerInterval = null;
            timerStartBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            timerStartBtn.classList.remove('running');
        } else {
            if (timerTotalSeconds <= 0) return;
            // Start
            timerInterval = setInterval(() => {
                timerTotalSeconds--;
                updateTimerDisplay();
                if (timerTotalSeconds <= 0) {
                    clearInterval(timerInterval);
                    timerInterval = null;
                    timerStartBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
                    timerStartBtn.classList.remove('running');
                    playNotificationSound();
                    showDesktopNotification('Timer Finished', { body: 'Time is up!' });
                }
            }, 1000);
            timerStartBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            timerStartBtn.classList.add('running');
        }
    };
}

if (timerResetBtn) {
    timerResetBtn.onclick = () => {
        clearInterval(timerInterval);
        timerInterval = null;
        timerTotalSeconds = 0;
        updateTimerDisplay();
        timerStartBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        timerStartBtn.classList.remove('running');
    };
}

// Tool Interception logic
function handleClockTool(tag) {
    const actionMatch = /action=["']([^"']+)["']/.exec(tag);
    const valueMatch = /value=["']([^"']+)["']/.exec(tag);
    
    if (!actionMatch) return;
    const action = actionMatch[1];
    const value = valueMatch ? valueMatch[1] : null;

    if (action === 'open') {
        openClock(value || 'clock');
    } else if (action === 'start_stopwatch') {
        openClock('stopwatch');
        if (!stopwatchInterval) stopwatchStartBtn.click();
    } else if (action === 'start_timer') {
        openClock('timer');
        if (value) {
            timerTotalSeconds = parseInt(value) * 60;
            updateTimerDisplay();
        }
        if (!timerInterval) timerStartBtn.click();
    } else if (action === 'close') {
        closeClock();
    }
}

async function send() {
    if (send_button.disabled || input.classList.contains('thinking')) return;

    const prompt = input.value;
    const imagesSnapshot = [...pendingImages];
    if (!prompt.trim() && imagesSnapshot.length === 0) return;

    if (!currentChatId) {
        createNewChat();
    }

    const activeChatId = currentChatId;
    let chat = chats.find(c => c.id === activeChatId);

    const userMessageContent = buildUserMessageContent(prompt, imagesSnapshot);
    chat.messages.push({ role: 'user', content: userMessageContent });

    if (chat.messages.length === 1 || chat.title === "New Chat") {
        const titleSrc = messageTitleSource(userMessageContent);
        chat.title = titleSrc.substring(0, 25) + (titleSrc.length > 25 ? "..." : "");
    }
    saveChats();
    renderChatList();

    const aiOutput = document.getElementById('aiOutput');
    const outputContainer = document.querySelector('.ai_output_container');

    if (outputContainer && !outputContainer.classList.contains('visible')) {
        outputContainer.classList.add('visible');
    }

    const userMessage = document.createElement('div');
    userMessage.className = 'message user';

    const userContentDiv = document.createElement('div');
    userContentDiv.className = 'message-content';
    populateUserMessageContent(userContentDiv, userMessageContent);
    userMessage.appendChild(userContentDiv);

    aiOutput.appendChild(userMessage);

    // Add abort button to the user message bubble
    const msgAbortBtn = document.createElement('button');
    msgAbortBtn.className = 'message-abort-btn';
    msgAbortBtn.type = 'button';
    msgAbortBtn.title = 'Abort request';
    msgAbortBtn.innerHTML = '<i class="fa-solid fa-arrow-rotate-left"></i>';
    msgAbortBtn.onclick = () => abortRequest();
    userMessage.appendChild(msgAbortBtn);

    send_button.disabled = true;
    send_button.classList.add('disabled');
    input.placeholder = "Thinking...";
    input.classList.add('thinking');

    input.value = "";
    clearImages();
    autoExpand();

    aiOutput.parentElement.scrollTop = aiOutput.parentElement.scrollHeight;

    try {

        const systemPrompt =
            `You are a highly capable, witty, and honest AI assistant named Biv. 

            ### Core Personality & Behavior
            * **Authentic & Adaptive:** You have a sharp wit, use humor, and express opinions.
            * **The "Truth First" Rule:** Accuracy is your priority. Gently but directly correct user errors.

            ### Environment
            User OS: ${process.platform}
            Current Time: ${new Date().toLocaleString()}
            
            ### Interaction Style
            * Be fast and decisive.
            * If a prompt is ambiguous, provide a brief, high-quality answer and ask one targeted follow-up question to refine your help.
            * Don't be afraid to use humor, but never at the expense of being helpful.
            
            Whenever you answer, explain what you are doing!
            
            ### Clock Tool
            You can control a clock widget for the user. To use it, include one of these tags in your response:
            - Open clock: <clock action="open" value="clock" />
            - Open timer: <clock action="open" value="timer" />
            - Open stopwatch: <clock action="open" value="stopwatch" />
            - Start timer: <clock action="start_timer" value="X" /> (where X is the number of minutes as a plain number)
            - Start stopwatch: <clock action="start_stopwatch" />
            - Close clock: <clock action="close" />
            
            Always confirm the action to the user as well.`;

        const selectedModelKey = currentModelKey;

        currentAbortController = new AbortController();
        const result = await requestAssistantFromBackend(systemPrompt, chat.messages, currentAbortController.signal);

        const visionHint = result.modelSwitchedForVision
            ? `\n\n_(This chat includes images, so **${modelDisplayName(result.modelForRequestKey)}** was used because **${modelDisplayName(selectedModelKey)}** does not accept images.)_`
            : '';

        if (result.ok && result.assistantText != null) {
            let assistantMessageContent = result.assistantText;

            chat.messages.push({ role: 'assistant', content: assistantMessageContent });
            saveChats();

            if (currentChatId === activeChatId) {
                const assistantMessage = document.createElement('div');
                assistantMessage.className = 'message assistant';
                aiOutput.appendChild(assistantMessage);

                const assistantContent = document.createElement('div');
                assistantContent.className = 'message-content';
                assistantMessage.appendChild(assistantContent);

                if (currentAbortController && !currentAbortController.signal.aborted) {
                    await typeMessage(assistantContent, assistantMessageContent, 2, currentAbortController.signal);
                    
                    // Parse for tools
                    const clockTags = assistantMessageContent.match(/<clock\s+[^>]*\/>/g);
                    if (clockTags) {
                        clockTags.forEach(tag => handleClockTool(tag));
                    }
                }
                aiOutput.parentElement.scrollTop = aiOutput.parentElement.scrollHeight;
                
                // Send notifications
                playNotificationSound();
                showDesktopNotification('Response received', { body: 'Your AI response is ready!' });
            }
        } else if (result.errorText) {
            const assistantMessageContent = `**Could not get a reply**\n\n${result.errorText}${visionHint}`;
            chat.messages.push({ role: 'assistant', content: assistantMessageContent });
            saveChats();

            if (currentChatId === activeChatId) {
                const assistantMessage = document.createElement('div');
                assistantMessage.className = 'message assistant assistant-error';
                aiOutput.appendChild(assistantMessage);
                const assistantContent = document.createElement('div');
                assistantContent.className = 'message-content';
                assistantMessage.appendChild(assistantContent);
                assistantContent.innerHTML = parseMarkdown(assistantMessageContent);
                aiOutput.parentElement.scrollTop = aiOutput.parentElement.scrollHeight;
            }
        } else {
            const assistantMessageContent =
                '**Unexpected response**\n\nThe API did not return a usable reply. Check the console for details.';
            console.error('Unexpected backend result:', result);
            chat.messages.push({ role: 'assistant', content: assistantMessageContent });
            saveChats();
            if (currentChatId === activeChatId) {
                const assistantMessage = document.createElement('div');
                assistantMessage.className = 'message assistant assistant-error';
                aiOutput.appendChild(assistantMessage);
                const assistantContent = document.createElement('div');
                assistantContent.className = 'message-content';
                assistantMessage.appendChild(assistantContent);
                assistantContent.innerHTML = parseMarkdown(assistantMessageContent);
                aiOutput.parentElement.scrollTop = aiOutput.parentElement.scrollHeight;
            }
        }
    } catch (err) {
        if (err.name === 'AbortError' || err.message === 'Aborted') {
            console.log('Request aborted.');
            removeMessageAbortButtons();
            return;
        }
        console.error("Error fetching AI response:", err.message);
        refreshOllamaBanner();
        const assistantMessageContent = `**Request failed**\n\n${err.message || String(err)}`;
        try {
            chat.messages.push({ role: "assistant", content: assistantMessageContent });
            saveChats();
            if (currentChatId === activeChatId) {
                const assistantMessage = document.createElement("div");
                assistantMessage.className = "message assistant assistant-error";
                aiOutput.appendChild(assistantMessage);
                const assistantContent = document.createElement("div");
                assistantContent.className = "message-content";
                assistantMessage.appendChild(assistantContent);
                assistantContent.innerHTML = parseMarkdown(assistantMessageContent);
                const oc = document.querySelector(".ai_output_container");
                if (oc) oc.scrollTop = oc.scrollHeight;
            }
        } catch (_) { /* ignore */ }
    } finally {
        currentAbortController = null;
        send_button.disabled = false;
        send_button.classList.remove('disabled');
        input.placeholder = "Ask anything…";
        input.classList.remove('thinking');
        removeMessageAbortButtons();
    }
}

function copyCode(button) {
    const wrapper = button.closest('.code-block-wrapper');
    if (wrapper) {
        const code = wrapper.querySelector('code').innerText;
        copyMessage(code, button);
    }
}

function copyMessage(text, button) {
    navigator.clipboard.writeText(text).then(() => {
        const originalHTML = button.innerHTML;
        button.innerHTML = '<i class=\"fa-solid fa-check\"></i>';
        button.classList.add('copied');

        setTimeout(() => {
            button.innerHTML = originalHTML;
            button.classList.remove('copied');
        }, 2000);
    });
}

input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!send_button.disabled && !input.classList.contains('thinking')) {
            send();
        }
    }
});

window.onfocus = () => {
    container.classList.add('active');
    input.focus();
};

function triggerHideSequence() {
    const outputContainer = document.querySelector('.ai_output_container');
    const hasMessages = document.getElementById('aiOutput').children.length > 0;

    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal && settingsModal.classList.contains('visible')) {
        settingsModal.classList.remove('visible');
    }

    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.remove('visible');
    }

    // Add Clock Widget to hide sequence
    if (clockWidget && clockWidget.classList.contains('visible')) {
        closeClock();
    }

    container.classList.add('animate-out');
    if (hasMessages && outputContainer) {
        outputContainer.classList.add('animate-out');
    }

    setTimeout(() => {
        container.classList.remove('animate-in');
        container.classList.remove('animate-out');
        if (outputContainer) {
            outputContainer.classList.remove('visible');
            outputContainer.classList.remove('animate-out');
        }
        ipcRenderer.send('hide-window-done');
    }, 400);
}

ipcRenderer.on('hide-window', triggerHideSequence);

document.addEventListener('click', (e) => {
    // If the click is on the transparent background
    if (e.target === document.body || e.target === document.documentElement) {
        triggerHideSequence();
        return;
    }
    const wrapper = document.querySelector('.model-selector-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        const list = document.getElementById('model-list');
        if (list) list.classList.remove('visible');
    }
});

// ============ SETTINGS SYSTEM ============

const SETTINGS_FILE = path.join(__dirname, '..', 'data', '.settings.json');

let appSettings = {
    theme: 'dark',
    soundNotify: false,
    desktopNotify: false
};

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const loaded = JSON.parse(data);
            appSettings = { ...appSettings, ...loaded };
        }
    } catch (e) {
        console.warn('Could not load settings:', e.message);
    }
    applyTheme(appSettings.theme);
    updateSettingsUI();
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2), 'utf8');
    } catch (e) {
        console.warn('Could not save settings:', e.message);
    }
}

function toggleSettings() {
    const modal = document.getElementById('settings-modal');
    if (modal) {
        modal.classList.toggle('visible');
    }
}

const settingsDragState = {
    active: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0
};



function changeTheme(themeName) {
    appSettings.theme = themeName;
    saveSettings();
    applyTheme(themeName);
}

function applyTheme(themeName) {
    document.documentElement.setAttribute('data-theme', themeName);
    
    if (themeName === 'light') {
        document.body.style.background = '#ffffff';
    } else if (themeName === 'transparent') {
        document.body.style.background = 'transparent';
    } else {
        document.body.style.background = 'transparent';
    }
}

function updateSettingsUI() {
    const themeInputs = document.querySelectorAll('input[name="theme"]');
    themeInputs.forEach(input => {
        input.checked = input.value === appSettings.theme;
    });
    
    const soundNotify = document.getElementById('sound-notify');
    const desktopNotify = document.getElementById('desktop-notify');
    if (soundNotify) soundNotify.checked = appSettings.soundNotify;
    if (desktopNotify) desktopNotify.checked = appSettings.desktopNotify;
}

function toggleSoundNotification() {
    appSettings.soundNotify = !appSettings.soundNotify;
    saveSettings();
}

function toggleDesktopNotification() {
    appSettings.desktopNotify = !appSettings.desktopNotify;
    saveSettings();
    if (appSettings.desktopNotify && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function playNotificationSound() {
    if (!appSettings.soundNotify) return;
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.value = 800;
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
}

function showDesktopNotification(title, options = {}) {
    if (!appSettings.desktopNotify) return;
    if (Notification.permission === 'granted') {
        new Notification(title, options);
    }
}

function exportChats() {
    try {
        const chatsData = {
            exportDate: new Date().toISOString(),
            version: '1.0',
            chats: chats
        };
        const dataStr = JSON.stringify(chatsData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `chats-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showDesktopNotification('Chats exported successfully!');
    } catch (e) {
        console.error('Export failed:', e.message);
        alert('Failed to export chats: ' + e.message);
    }
}

function importChats() {
    const fileInput = document.getElementById('import-file');
    if (fileInput) {
        fileInput.click();
    }
}

function handleImportChats(event) {
    const file = event.target?.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const content = e.target?.result;
            if (typeof content !== 'string') throw new Error('Invalid file');
            
            const data = JSON.parse(content);
            if (!Array.isArray(data.chats)) throw new Error('Invalid backup format');
            
            // Ask user before overwriting
            if (confirm('Import chats? This will merge with existing chats.')) {
                const importedChats = data.chats;
                
                // Merge chats (avoid duplicates by ID)
                const existingIds = new Set(chats.map(c => c.id));
                for (const chat of importedChats) {
                    if (!existingIds.has(chat.id)) {
                        chats.push(chat);
                    }
                }
                
                saveChats();
                renderChatList();
                showDesktopNotification('Chats imported successfully!');
                document.getElementById('import-file').value = '';
            }
        } catch (err) {
            console.error('Import failed:', err.message);
            alert('Failed to import chats: ' + err.message);
            document.getElementById('import-file').value = '';
        }
    };
    reader.readAsText(file);
}

function confirmClearChats() {
    if (confirm('⚠️  Are you sure? This will delete ALL chats permanently. This cannot be undone.')) {
        chats = [];
        currentChatId = null;
        saveChats();
        renderChatList();
        createNewChat();
        toggleSettings();
        showDesktopNotification('All chats cleared!');
    }
}

// ============ END SETTINGS SYSTEM ============

// Initialize app
setupOllamaMissingBanner();
refreshOllamaBanner();
updateModelBadge();
renderModelList();
loadSettings();
loadChats();
if (chats.length === 0) {
    switchChat(chats[0].id);
}

// Lifecycle Events
ipcRenderer.on('window-shown', () => {
    container.classList.add('animate-in');
    const chat = chats.find(c => c.id === activeChatId);
    if (chat && chat.messages.length > 0) {
        outputContainer.classList.add('animate-in');
    }
    setTimeout(() => input.focus(), 100);
});

// Safety fallback: if for some reason the event is missed at startup
setTimeout(() => {
    if (!container.classList.contains('animate-in')) {
        container.classList.add('animate-in');
    }
}, 2000);

ipcRenderer.on('hide-window', () => {
    container.classList.remove('animate-in');
    outputContainer.classList.remove('animate-in');
    if (document.activeElement) document.activeElement.blur();
});