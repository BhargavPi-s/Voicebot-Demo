// main.js

// DOM Elements
const callIndicator = document.getElementById('callIndicator');
const indicatorText = document.getElementById('indicatorText');
const startCallBtn = document.getElementById('startCallBtn');
const endCallBtn = document.getElementById('endCallBtn');
const statusMessage = document.getElementById('statusMessage');
const timer = document.getElementById('timer');
const conversationContainer = document.getElementById('conversationContainer');
const responseAudio = document.getElementById('responseAudio');

// App State
const appState = {
    conversationId: null,
    isCallActive: false,
    currentState: 'idle', // idle, listening, processing, speaking
    mediaRecorder: null,
    audioChunks: [],
    silenceTimeout: null,
    recordingStartTime: null,
    callStartTime: null,
    maxCallDuration: 5 * 60 * 1000, // 5 minutes in milliseconds
    silenceThreshold: 2000, // 2 seconds of silence before processing
    timerInterval: null,
    isProcessingAudio: false,
    webSocketConnection: null,
    isEndingCall: false // Flag to track call ending state
};

// Initialize the app
function init() {
    // Add event listeners
    startCallBtn.addEventListener('click', startCall);
    endCallBtn.addEventListener('click', endCall);
    callIndicator.addEventListener('click', toggleCall);
    
    // Set initial state
    updateState('idle');
}

// Toggle call state
function toggleCall() {
    if (appState.isCallActive) {
        endCall();
    } else {
        startCall();
    }
}

// Start a new call
async function startCall() {
    try {
        // Ensure we're not already in a call
        if (appState.isCallActive) return;
        
        // Request microphone permission
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Create a new conversation on the server
        const response = await fetch('/api/conversations', {
            method: 'POST'
        });
        
        const data = await response.json();
        appState.conversationId = data.conversation_id;
        
        // Update UI
        startCallBtn.disabled = true;
        endCallBtn.disabled = false;
        appState.isCallActive = true;
        appState.isEndingCall = false;
        appState.callStartTime = Date.now();
        conversationContainer.innerHTML = '';
        
        // Start the timer
        startTimer();
        
        // Initialize WebSocket connection
        initWebSocket();
        
        // Start recording
        startRecording(stream);
        startVolumeDetection(stream)
        
        // Update state to listening
        updateState('listening');
        
        showStatus('Call started. You can speak now.', 'info');
    } catch (error) {
        console.error('Error starting call:', error);
        showStatus(`Error: ${error.message}`, 'error');
    }
}

// Initialize WebSocket connection
function initWebSocket() {
    // Close any existing connections first
    if (appState.webSocketConnection) {
        appState.webSocketConnection.close();
        appState.webSocketConnection = null;
    }
    
    appState.webSocketConnection = new WebSocket(`ws://${window.location.host}/ws/${appState.conversationId}`);
    
    appState.webSocketConnection.onopen = () => {
        console.log('WebSocket connection established');
    };
    
    appState.webSocketConnection.onmessage = (event) => {
        // Only process messages if call is active
        if (!appState.isCallActive || appState.isEndingCall) return;
        
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
    
    appState.webSocketConnection.onerror = (error) => {
        console.error('WebSocket error:', error);
        if (appState.isCallActive && !appState.isEndingCall) {
            showStatus('Connection error. Please try again.', 'error');
        }
    };
    
    appState.webSocketConnection.onclose = () => {
        console.log('WebSocket connection closed');
    };
}

// Handle WebSocket messages
function handleWebSocketMessage(data) {
    // Ignore messages if call is ending
    if (appState.isEndingCall) return;
    
    if (data.status === 'error') {
        showStatus(`Error: ${data.message}`, 'error');
        updateState('listening');
    } else if (data.status === 'empty') {
        // No speech detected, continue listening
        updateState('listening');
    } else if (data.status === 'success') {
        // Display the conversation
        addMessageToConversation('user', data.transcript);
        addMessageToConversation('assistant', data.response);
        
        // Play the audio response
        playAudioResponse(data.audio);
    }
}

// Start recording audio
function startRecording(stream) {
    // Clear previous chunks
    appState.audioChunks = [];
    
    // Create a MediaRecorder instance
    appState.mediaRecorder = new MediaRecorder(stream);
    
    // Event handler for when data becomes available
    appState.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && !appState.isEndingCall) {
            appState.audioChunks.push(event.data);
        }
    };
    
    // Event handler for when recording stops
    appState.mediaRecorder.onstop = () => {
        // Skip processing if we're ending the call
        if (appState.isEndingCall || !appState.isCallActive) {
            return;
        }
        
        // Only process if we're still in an active call and not already processing
        if (appState.isCallActive && !appState.isProcessingAudio) {
            processAudioInput();
        }
    };
    
    // Start recording
    appState.mediaRecorder.start();
    appState.recordingStartTime = Date.now();
    

}

let audioContext, analyser, microphone, javascriptNode;

function startVolumeDetection(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    microphone = audioContext.createMediaStreamSource(stream);
    javascriptNode = audioContext.createScriptProcessor(2048, 1, 1);

    analyser.smoothingTimeConstant = 0.8;
    analyser.fftSize = 1024;

    microphone.connect(analyser);
    analyser.connect(javascriptNode);
    javascriptNode.connect(audioContext.destination);

    javascriptNode.onaudioprocess = () => {
        const array = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(array);

        const volume = array.reduce((a, b) => a + b) / array.length;

        if (volume > 10) {
            // Speaking, reset silence timeout
            if (appState.silenceTimeout) clearTimeout(appState.silenceTimeout);
            appState.silenceTimeout = setTimeout(stopRecordingDueToSilence, appState.silenceThreshold);
        }
    };
}

function stopRecordingDueToSilence() {
    if (appState.mediaRecorder && appState.mediaRecorder.state === 'recording') {
        appState.mediaRecorder.stop();
    }
}


// Process the recorded audio
async function processAudioInput() {
    // Skip if call is ending
    if (appState.isEndingCall) return;
    
    // Set processing flag to avoid multiple simultaneous processing
    appState.isProcessingAudio = true;
    
    // Update state to processing
    updateState('processing');
    
    try {
        // Create a blob from the audio chunks
        const audioBlob = new Blob(appState.audioChunks, { type: 'audio/webm' });
        
        // If the audio is too short or empty, restart recording
        if (audioBlob.size < 1000) {
            showStatus('Audio too short. Please speak again.', 'info');
            updateState('listening');
            appState.isProcessingAudio = false;
            
            // Restart recording if the call is still active
            if (appState.isCallActive && !appState.isEndingCall && appState.mediaRecorder) {
                appState.audioChunks = [];
                appState.mediaRecorder.start();
            }
            return;
        }
        
        // Create a FormData object
        const formData = new FormData();
        formData.append('file', audioBlob);
        formData.append('conversation_id', appState.conversationId);
        
        // Send the audio to the server
        const response = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData
        });
        
        // Parse the response
        const data = await response.json();
        
        // Handle the response
        if (data.status === 'error') {
            showStatus(`Error: ${data.message}`, 'error');
            updateState('listening');
        } else if (data.status === 'empty') {
            showStatus('No speech detected. Please try again.', 'info');
            updateState('listening');
        } else if (data.status === 'success') {
            // Display the conversation
            addMessageToConversation('user', data.transcript);
            addMessageToConversation('assistant', data.response);
            
            // Play the audio response
            playAudioResponse(data.audio);
        }
    } catch (error) {
        console.error('Error processing audio:', error);
        if (!appState.isEndingCall) {
            showStatus(`Error processing audio: ${error.message}`, 'error');
            updateState('listening');
        }
    } finally {
        // Reset processing flag
        appState.isProcessingAudio = false;
        
        // Restart recording if the call is still active and not in speaking state and not ending
        if (appState.isCallActive && !appState.isEndingCall && appState.currentState !== 'speaking' && appState.mediaRecorder) {
            appState.audioChunks = [];
            appState.mediaRecorder.start();
        }
    }
}

// Play the audio response
function playAudioResponse(audioBase64) {
    // Skip if call is ending
    if (appState.isEndingCall) return;
    
    updateState('speaking');
    
    // Convert base64 to blob
    const audioBlob = base64ToBlob(audioBase64, 'audio/mp3');
    const audioUrl = URL.createObjectURL(audioBlob);
    
    // Set the audio source
    responseAudio.src = audioUrl;
    
    // Play the audio
    responseAudio.play().catch(error => {
        console.error('Error playing audio:', error);
        if (!appState.isEndingCall) {
            showStatus('Error playing audio response', 'error');
        }
    });
    
    // When audio ends, go back to listening state
    responseAudio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        
        // Only update state if call is still active
        if (appState.isCallActive && !appState.isEndingCall) {
            updateState('listening');
            
            // Restart recording
            if (appState.mediaRecorder) {
                appState.audioChunks = [];
                appState.mediaRecorder.start();
            }
        }
    };
}

// Convert base64 to Blob
function base64ToBlob(base64, mimeType) {
    const byteCharacters = atob(base64);
    const byteArrays = [];
    
    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        
        for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
        }
        
        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
    }
    
    return new Blob(byteArrays, { type: mimeType });
}

// End the call
async function endCall() {
    try {
        // Set ending flag first to prevent new processes
        appState.isEndingCall = true;
        
        // Update state to idle immediately
        updateState('idle');
        
        // Stop recording
        if (appState.mediaRecorder && appState.mediaRecorder.state === 'recording') {
            appState.mediaRecorder.stop();
        }
        
        // End the conversation on the server
        if (appState.conversationId) {
            await fetch(`/api/conversations/${appState.conversationId}`, {
                method: 'DELETE'
            });
        }
        
        // Close WebSocket connection
        if (appState.webSocketConnection) {
            appState.webSocketConnection.close();
            appState.webSocketConnection = null;
        }
        
        // Stop all media tracks
        if (appState.mediaRecorder && appState.mediaRecorder.stream) {
            appState.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
        
        // Clear timeouts and intervals
        if (appState.silenceTimeout) {
            clearTimeout(appState.silenceTimeout);
        }
        
        if (appState.timerInterval) {
            clearInterval(appState.timerInterval);
        }
        
        // Stop audio playback if it's playing
        if (!responseAudio.paused) {
            responseAudio.pause();
            responseAudio.currentTime = 0;
        }
        
        // Update UI
        startCallBtn.disabled = false;
        endCallBtn.disabled = true;
        appState.isCallActive = false;
        timer.textContent = '00:00';
        
        // Reset app state
        appState.conversationId = null;
        appState.mediaRecorder = null;
        appState.audioChunks = [];
        appState.silenceTimeout = null;
        appState.recordingStartTime = null;
        appState.callStartTime = null;
        appState.isProcessingAudio = false;
        
        showStatus('Call ended.', 'info');
        
        // Reset ending flag at the end of the process
        setTimeout(() => {
            appState.isEndingCall = false;
        }, 500);
    } catch (error) {
        console.error('Error ending call:', error);
        showStatus(`Error: ${error.message}`, 'error');
        // Make sure we still reset state even on error
        appState.isCallActive = false;
        appState.isEndingCall = false;
        updateState('idle');
    }
}

// Start the timer
function startTimer() {
    // Clear any existing timer
    if (appState.timerInterval) {
        clearInterval(appState.timerInterval);
    }
    
    // Update timer immediately
    updateTimer();
    
    // Set interval to update timer every second
    appState.timerInterval = setInterval(() => {
        updateTimer();
        
        // Check if call has exceeded max duration
        const currentTime = Date.now();
        if (currentTime - appState.callStartTime >= appState.maxCallDuration) {
            showStatus('Maximum call duration reached (5 minutes).', 'info');
            endCall();
        }
    }, 1000);
}

// Update the timer display
function updateTimer() {
    if (!appState.callStartTime) return;
    
    const currentTime = Date.now();
    const elapsedTime = currentTime - appState.callStartTime;
    
    const minutes = Math.floor(elapsedTime / 60000);
    const seconds = Math.floor((elapsedTime % 60000) / 1000);
    
    timer.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Add a message to the conversation container
function addMessageToConversation(role, content) {
    // Skip if call is ending
    if (appState.isEndingCall) return;
    
    const messageElement = document.createElement('div');
    messageElement.className = `message ${role}-message`;
    messageElement.textContent = content;
    
    conversationContainer.appendChild(messageElement);
    
    // Scroll to the bottom of the container
    conversationContainer.scrollTop = conversationContainer.scrollHeight;
}

// Show a status message
function showStatus(message, type = 'info') {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    
    // Clear the message after 5 seconds
    setTimeout(() => {
        if (statusMessage.textContent === message) {
            statusMessage.textContent = '';
            statusMessage.className = 'status-message';
        }
    }, 5000);
}

// Update the app state
function updateState(newState) {
    // If we're ending the call, force to idle state
    if (appState.isEndingCall && newState !== 'idle') {
        newState = 'idle';
    }
    
    appState.currentState = newState;
    
    // Remove all state classes
    callIndicator.classList.remove('listening', 'processing', 'speaking');
    
    // Update UI based on state
    switch (newState) {
        case 'idle':
            indicatorText.textContent = 'Start Call';
            break;
        case 'listening':
            indicatorText.textContent = 'Listening...';
            callIndicator.classList.add('listening');
            break;
        case 'processing':
            indicatorText.textContent = 'Processing...';
            callIndicator.classList.add('processing');
            break;
        case 'speaking':
            indicatorText.textContent = 'Speaking...';
            callIndicator.classList.add('speaking');
            break;
    }
}
// Add this case inside handleWebSocketMessage()
function handleWebSocketMessage(data) {
    if (appState.isEndingCall) return;

    if (data.status === 'error') {
        showStatus(`Error: ${data.message}`, 'error');
        updateState('listening');
    } else if (data.status === 'empty') {
        updateState('listening');
    } else if (data.status === 'success') {
        addMessageToConversation('user', data.transcript);
        addMessageToConversation('assistant', data.response);
        playAudioResponse(data.audio);
    } else if (data.status === 'ended') {
        addMessageToConversation('user', data.transcript);
        addMessageToConversation('assistant', data.response);
        playAudioResponse(data.audio);
        showStatus('Call ended by assistant.', 'info');
        setTimeout(() => endCall(), 2000); // End gracefully after TTS
    }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', init);