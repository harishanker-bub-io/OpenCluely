document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const assemblyaiKeyInput = document.getElementById('assemblyaiKey');
    const geminiKeyInput = document.getElementById('geminiKey');
    const groqKeyInput = document.getElementById('groqKey');
    const groqSpeechKeyInput = document.getElementById('groqSpeechKey');
    const llmProviderSelect = document.getElementById('llmProvider');
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

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        if (assemblyaiKeyInput) assemblyaiKeyInput.value = settings.assemblyaiKey || '';
        if (geminiKeyInput) geminiKeyInput.value = settings.geminiKey || '';
        if (groqKeyInput) groqKeyInput.value = settings.groqKey || '';
        if (groqSpeechKeyInput) groqSpeechKeyInput.value = settings.groqKey || '';
        if (llmProviderSelect) llmProviderSelect.value = settings.llmProvider || 'gemini';
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

        updateSpeechFieldStates();
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
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (assemblyaiKeyInput) settings.assemblyaiKey = assemblyaiKeyInput.value;
        if (geminiKeyInput) settings.geminiKey = geminiKeyInput.value;
        if (groqKeyInput) settings.groqKey = groqKeyInput.value;
        if (groqSpeechKeyInput) settings.groqKey = groqSpeechKeyInput.value;
        if (llmProviderSelect) settings.llmProvider = llmProviderSelect.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        if (resumeInput) settings.resume = resumeInput.value;
        if (windowOpacitySlider) settings.windowOpacity = parseFloat(windowOpacitySlider.value);
        if (microphoneDeviceSelect) settings.microphoneDeviceId = microphoneDeviceSelect.value || 'default';
        
        window.api.send('save-settings', settings);
    };

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'groq';

        const groqGroup = document.getElementById('groqSpeechFields');
        const assemblyaiGroup = document.getElementById('assemblyaiSpeechFields');

        if (groqGroup) {
            groqGroup.style.display = provider === 'groq' ? '' : 'none';
        }
        if (assemblyaiGroup) {
            assemblyaiGroup.style.display = provider === 'assemblyai' ? '' : 'none';
        }
    };

    // Add event listeners for all inputs
    const inputs = [
        assemblyaiKeyInput,
        geminiKeyInput,
        groqKeyInput,
        groqSpeechKeyInput,
        windowGapInput,
        resumeInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    if (refreshMicrophonesButton) refreshMicrophonesButton.addEventListener('click', () => refreshMicrophones());
    if (startMicTestButton) startMicTestButton.addEventListener('click', startMicrophoneTest);
    if (stopMicTestButton) stopMicTestButton.addEventListener('click', stopMicrophoneTest);
    if (microphoneDeviceSelect) microphoneDeviceSelect.addEventListener('change', async () => {
        stopMicrophoneTest();
        await window.electronAPI.saveSettings({ microphoneDeviceId: microphoneDeviceSelect.value || 'default' });
    });

    if (groqKeyInput && groqSpeechKeyInput) {
        groqKeyInput.addEventListener('input', () => { groqSpeechKeyInput.value = groqKeyInput.value; });
        groqSpeechKeyInput.addEventListener('input', () => { groqKeyInput.value = groqSpeechKeyInput.value; });
    }

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    updateSpeechFieldStates();

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

    // LLM provider field toggle
    const updateLLMFieldStates = () => {
        const provider = llmProviderSelect ? llmProviderSelect.value : 'gemini';
        const geminiGroup = document.getElementById('geminiFields');
        const groqGroup = document.getElementById('groqFields');
        if (geminiGroup) geminiGroup.style.display = provider === 'gemini' ? '' : 'none';
        if (groqGroup) groqGroup.style.display = provider === 'groq' ? '' : 'none';
    };

    if (llmProviderSelect) {
        llmProviderSelect.addEventListener('change', () => {
            updateLLMFieldStates();
            saveSettings();
        });
    }
    updateLLMFieldStates();

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
