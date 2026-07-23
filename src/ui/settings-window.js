document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // ── Provider registry (mirrors config.js so the UI can build
    //     dropdowns without an IPC round-trip) ────────────────────
    const PROVIDER_REGISTRY = {
      gemini:   { name:'Google Gemini', apiKeyEnv:'GEMINI_API_KEY',   capabilities:{text:true,image:true,voice:false}, models:{text:['gemini-3.1-flash-lite','gemma-4-31b-it','gemini-3.5-flash-lite'],image:['gemini-3.1-flash-lite','gemma-4-31b-it','gemini-3.5-flash-lite']} },
      groq:     { name:'Groq',          apiKeyEnv:'GROQ_API_KEY',     capabilities:{text:true,image:true,voice:true},  models:{text:['qwen/qwen3.6-27b','openai/gpt-oss-120b','meta-llama/llama-4-maverick-17b-128e-instruct'],image:['qwen/qwen3.6-27b'],voice:['whisper-large-v3-turbo']} },
      cerebras: { name:'Cerebras',      apiKeyEnv:'CEREBRAS_API_KEY', capabilities:{text:true,image:true,voice:false}, models:{text:['zai-glm-4.7','gemma-4-31b'],image:['gemma-4-31b']} },
      assemblyai:{ name:'AssemblyAI',   apiKeyEnv:'ASSEMBLYAI_API_KEY',capabilities:{text:false,image:false,voice:true}, models:{voice:['universal-3-5-pro']} },
    };
    const CATEGORIES = ['text','image','voice'];

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const textProviderSelect  = document.getElementById('textProvider');
    const textModelSelect     = document.getElementById('textModel');
    const imageProviderSelect = document.getElementById('imageProvider');
    const imageModelSelect    = document.getElementById('imageModel');
    const voiceProviderSelect = document.getElementById('voiceProvider');
    const voiceModelSelect    = document.getElementById('voiceModel');
    const apiKeysContainer    = document.getElementById('apiKeysContainer');
    const windowGapInput = document.getElementById('windowGap');
    const windowOpacitySlider = document.getElementById('windowOpacity');
    const opacityValueLabel = document.getElementById('opacityValue');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const resumeInput = document.getElementById('resumeInput');
    const iconGrid = document.getElementById('iconGrid');
    const microphoneDeviceSelect = document.getElementById('microphoneDevice');
    const refreshMicrophonesButton = document.getElementById('refreshMicrophones');
    const startMicTestButton = document.getElementById('startMicTest');
    const stopMicTestButton = document.getElementById('stopMicTest');
    const micTestStatus = document.getElementById('micTestStatus');
    const micLevel = document.getElementById('micLevel');
    const micTestPlayback = document.getElementById('micTestPlayback');
    let micTestStream = null;
    let micTestRecorder = null;
    let micTestContext = null;
    let micTestFrame = null;
    let micTestStopTimer = null;
    let micTestChunks = [];

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            stopMicrophoneTest();
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    const setMicTestStatus = (message) => {
        if (micTestStatus) micTestStatus.textContent = message;
    };

    const stopMicrophoneTest = () => {
        if (micTestStopTimer) clearTimeout(micTestStopTimer);
        micTestStopTimer = null;
        if (micTestFrame) cancelAnimationFrame(micTestFrame);
        micTestFrame = null;
        if (micLevel) micLevel.style.width = '0%';
        const recorder = micTestRecorder;
        micTestRecorder = null;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        if (micTestStream) micTestStream.getTracks().forEach(track => track.stop());
        micTestStream = null;
        if (micTestContext) micTestContext.close().catch(() => {});
        micTestContext = null;
        if (startMicTestButton) startMicTestButton.style.display = '';
        if (stopMicTestButton) stopMicTestButton.style.display = 'none';
    };

    const refreshMicrophones = async (selectedDeviceId = null) => {
        if (!microphoneDeviceSelect) return;
        const previousValue = selectedDeviceId || microphoneDeviceSelect.value || 'default';
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inputs = devices.filter(device => device.kind === 'audioinput');
            microphoneDeviceSelect.replaceChildren();
            microphoneDeviceSelect.add(new Option('System default', 'default'));
            inputs.forEach((device, index) => {
                microphoneDeviceSelect.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId));
            });
            microphoneDeviceSelect.value = [...microphoneDeviceSelect.options].some(option => option.value === previousValue)
                ? previousValue
                : 'default';
            if (previousValue !== microphoneDeviceSelect.value && window.electronAPI) {
                await window.electronAPI.saveSettings({ microphoneDeviceId: 'default' });
            }
            setMicTestStatus(inputs.length ? 'Microphones are ready.' : 'No microphone was found.');
        } catch (error) {
            setMicTestStatus(`Microphone permission is required: ${error.message}`);
        }
    };

    const startMicrophoneTest = async () => {
        if (!microphoneDeviceSelect || !window.MediaRecorder) {
            setMicTestStatus('Microphone testing is not supported in this window.');
            return;
        }
        stopMicrophoneTest();
        try {
            const deviceId = microphoneDeviceSelect.value || 'default';
            micTestStream = await navigator.mediaDevices.getUserMedia(
                deviceId === 'default' ? { audio: true } : { audio: { deviceId: { exact: deviceId } } }
            );
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            micTestContext = new AudioContextClass();
            const analyser = micTestContext.createAnalyser();
            const samples = new Uint8Array(analyser.fftSize);
            micTestContext.createMediaStreamSource(micTestStream).connect(analyser);
            const drawLevel = () => {
                analyser.getByteTimeDomainData(samples);
                const level = samples.reduce((total, value) => total + Math.abs(value - 128), 0) / samples.length;
                if (micLevel) micLevel.style.width = `${Math.min(100, level * 4)}%`;
                micTestFrame = requestAnimationFrame(drawLevel);
            };
            drawLevel();
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
            micTestChunks = [];
            micTestRecorder = new MediaRecorder(micTestStream, { mimeType });
            micTestRecorder.ondataavailable = event => { if (event.data.size) micTestChunks.push(event.data); };
            micTestRecorder.onstop = () => {
                if (micTestChunks.length && micTestPlayback) {
                    micTestPlayback.src = URL.createObjectURL(new Blob(micTestChunks, { type: mimeType }));
                    micTestPlayback.style.display = '';
                    setMicTestStatus('Test complete. Play the recording to verify your microphone.');
                }
            };
            micTestRecorder.start();
            micTestStopTimer = setTimeout(stopMicrophoneTest, 5000);
            if (startMicTestButton) startMicTestButton.style.display = 'none';
            if (stopMicTestButton) stopMicTestButton.style.display = '';
            setMicTestStatus('Testing microphone for up to five seconds…');
        } catch (error) {
            setMicTestStatus(`Could not start microphone test: ${error.message}`);
            stopMicrophoneTest();
        }
    };

    // ── Build API key fields dynamically from the provider registry ─
    const buildApiKeyFields = (savedKeys) => {
        if (!apiKeysContainer) return;
        apiKeysContainer.innerHTML = '';
        const keys = savedKeys || {};
        Object.entries(PROVIDER_REGISTRY).forEach(([key, p]) => {
            const div = document.createElement('div');
            div.className = 'settings-item';
            div.dataset.provider = key;
            const placeholders = { GEMINI_API_KEY:'Enter your Google API key', GROQ_API_KEY:'gsk_…', CEREBRAS_API_KEY:'csk_…', ASSEMBLYAI_API_KEY:'Enter your AssemblyAI API key' };
            div.innerHTML = `<div>
                <div class="settings-item-label">${p.name} API Key</div>
                <div class="settings-item-description">Used when ${p.name} is selected as a provider</div>
            </div>
            <input type="password" class="input-field api-key-input" data-provider="${key}"
                   placeholder="${placeholders[p.apiKeyEnv] || 'Enter your API key'}"
                   value="${keys[key] || ''}">`;
            apiKeysContainer.appendChild(div);
        });
    };

    // ── Cascading: repopulate model dropdown when provider changes ─
    const populateModels = (category, provider) => {
        const modelSelect = document.getElementById(category + 'Model');
        if (!modelSelect) return;
        const models = (PROVIDER_REGISTRY[provider] && PROVIDER_REGISTRY[provider].models && PROVIDER_REGISTRY[provider].models[category]) || [];
        modelSelect.innerHTML = '';
        if (models.length === 0) {
            modelSelect.add(new Option('(none available)', ''));
        } else {
            models.forEach(m => modelSelect.add(new Option(m, m)));
        }
    };

    // ── Build all provider dropdowns ───────────────────────────────
    const buildProviderDropdowns = (savedSelection) => {
        const sel = savedSelection || {};
        CATEGORIES.forEach(cat => {
            const providerSelect = document.getElementById(cat + 'Provider');
            if (!providerSelect) return;
            providerSelect.innerHTML = '';
            const providers = Object.entries(PROVIDER_REGISTRY)
                .filter(([,p]) => p.capabilities && p.capabilities[cat])
                .map(([k,p]) => ({key:k, name:p.name}));
            if (providers.length === 0) {
                providerSelect.add(new Option('(none available)', ''));
                return;
            }
            providers.forEach(p => providerSelect.add(new Option(p.name, p.key)));
            const saved = (sel[cat] && sel[cat].provider) || '';
            providerSelect.value = providers.some(p => p.key === saved) ? saved : providers[0].key;
            populateModels(cat, providerSelect.value);
            const modelSelect = document.getElementById(cat + 'Model');
            if (modelSelect) {
                const savedModel = (sel[cat] && sel[cat].model) || '';
                if ([...modelSelect.options].some(o => o.value === savedModel)) {
                    modelSelect.value = savedModel;
                }
            }
        });
    };

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        const modelSelection = settings.modelSelection || {};
        buildProviderDropdowns(modelSelection);

        const apiKeys = {};
        Object.keys(PROVIDER_REGISTRY).forEach(k => {
            const envKey = PROVIDER_REGISTRY[k].apiKeyEnv;
            apiKeys[k] = settings[envKey] || settings[`${k}Key`] || '';
        });
        buildApiKeyFields(apiKeys);

        if (windowGapInput) windowGapInput.value = settings.windowGap || '';
        if (windowOpacitySlider && settings.windowOpacity !== undefined) {
            windowOpacitySlider.value = settings.windowOpacity;
            if (opacityValueLabel) opacityValueLabel.textContent = parseFloat(settings.windowOpacity).toFixed(2);
            // Also apply to the settings window's own background
            document.documentElement.style.setProperty('--app-opacity', settings.windowOpacity);
        }

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;
        if (settings.resume && resumeInput) resumeInput.value = settings.resume;
        refreshMicrophones(settings.microphoneDeviceId || 'default');

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};

        // Model selection per category
        const modelSelection = {};
        CATEGORIES.forEach(cat => {
            const providerSelect = document.getElementById(cat + 'Provider');
            const modelSelect = document.getElementById(cat + 'Model');
            if (providerSelect && modelSelect) {
                modelSelection[cat] = { provider: providerSelect.value, model: modelSelect.value };
            }
        });
        settings.modelSelection = modelSelection;

        // API keys from the dynamically-built fields
        if (apiKeysContainer) {
            apiKeysContainer.querySelectorAll('.api-key-input').forEach(input => {
                const provider = input.dataset.provider;
                const envKey = PROVIDER_REGISTRY[provider] ? PROVIDER_REGISTRY[provider].apiKeyEnv : null;
                if (envKey && input.value) settings[envKey] = input.value;
            });
        }

        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        if (resumeInput) settings.resume = resumeInput.value;
        if (windowOpacitySlider) settings.windowOpacity = parseFloat(windowOpacitySlider.value);
        if (microphoneDeviceSelect) settings.microphoneDeviceId = microphoneDeviceSelect.value || 'default';

        window.api.send('save-settings', settings);
    };

    // ── Wire up cascading provider → model for all 3 categories ──
    CATEGORIES.forEach(cat => {
        const providerSelect = document.getElementById(cat + 'Provider');
        const modelSelect = document.getElementById(cat + 'Model');
        if (providerSelect) {
            providerSelect.addEventListener('change', () => {
                populateModels(cat, providerSelect.value);
                saveSettings();
            });
        }
        if (modelSelect) {
            modelSelect.addEventListener('change', () => saveSettings());
        }
    });

    // Wire up API key fields
    if (apiKeysContainer) {
        apiKeysContainer.addEventListener('change', saveSettings);
        apiKeysContainer.addEventListener('blur', (e) => {
            if (e.target.classList.contains('api-key-input')) saveSettings();
        });
    }

    // Non-provider inputs
    [windowGapInput, resumeInput].forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (refreshMicrophonesButton) refreshMicrophonesButton.addEventListener('click', () => refreshMicrophones());
    if (startMicTestButton) startMicTestButton.addEventListener('click', startMicrophoneTest);
    if (stopMicTestButton) stopMicTestButton.addEventListener('click', stopMicrophoneTest);
    if (microphoneDeviceSelect) microphoneDeviceSelect.addEventListener('change', async () => {
        stopMicrophoneTest();
        await window.electronAPI.saveSettings({ microphoneDeviceId: microphoneDeviceSelect.value || 'default' });
    });

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            window.api.send('update-skill', e.target.value);
        });
    }

    // Opacity slider: live preview while dragging, persist on release
    if (windowOpacitySlider) {
        windowOpacitySlider.addEventListener('input', () => {
            const val = parseFloat(windowOpacitySlider.value);
            if (opacityValueLabel) opacityValueLabel.textContent = val.toFixed(2);
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ windowOpacity: val });
            }
        });
        windowOpacitySlider.addEventListener('change', () => {
            saveSettings();
        });
    }

    // Keep slider in sync when opacity is changed via keyboard shortcuts
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('opacity-changed', (_event, data) => {
            if (data && data.opacity !== undefined && windowOpacitySlider) {
                windowOpacitySlider.value = data.opacity;
                if (opacityValueLabel) opacityValueLabel.textContent = parseFloat(data.opacity).toFixed(2);
            }
        });
    }

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            stopMicrophoneTest();
            window.api.send('close-settings');
        }
    });
    window.addEventListener('beforeunload', stopMicrophoneTest);
}); 
