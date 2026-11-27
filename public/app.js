const $ = (id) => document.getElementById(id);
const startButton = $('start-button');
const stopButton = $('stop-button');
const statusDot = $('status-dot');
const statusText = $('status-text');
const messageList = $('messages');
const notice = $('notice');
let socket;
let audioContext;
let micStream;
let source;
let worklet;
let sessionId;
let recording = false;
let audioQueue = Promise.resolve();
let activeAssistantBubble;
let currentPlayer;
let apiKey = sessionStorage.getItem('micdrop-api-key') || '';

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
  let response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    const entered = window.prompt(
      'Enter the API key configured on this Micdrop server:'
    );
    if (entered) {
      apiKey = entered;
      sessionStorage.setItem('micdrop-api-key', apiKey);
      headers.set('Authorization', `Bearer ${apiKey}`);
      response = await fetch(url, { ...options, headers });
    }
  }
  return response;
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
}
function clearNotice() {
  notice.hidden = true;
  notice.textContent = '';
}
function status(message, state = '') {
  statusText.textContent = message;
  statusDot.className = state;
}
function ensureConversation() {
  $('empty-state')?.remove();
}
function addBubble(role, text = '') {
  ensureConversation();
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  const speaker = document.createElement('span');
  speaker.className = 'speaker';
  speaker.textContent = role;
  const content = document.createElement('span');
  content.className = 'content';
  content.textContent = text;
  bubble.append(speaker, content);
  messageList.append(bubble);
  messageList.scrollTop = messageList.scrollHeight;
  return bubble;
}
function addTranscript(text) {
  if (text) addBubble('user', text);
}
function socketSend(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
function playWav(encoded) {
  audioQueue = audioQueue
    .then(async () => {
      if (!recording) return;
      const raw = atob(encoded);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const context = audioContext || new AudioContext();
      audioContext = context;
      const buffer = await context.decodeAudioData(bytes.buffer);
      if (!recording) return;
      const player = context.createBufferSource();
      currentPlayer = player;
      player.buffer = buffer;
      player.connect(context.destination);
      player.start();
      await new Promise((resolve) => {
        player.onended = resolve;
      });
      if (currentPlayer === player) currentPlayer = undefined;
    })
    .catch((error) => console.error('Audio playback failed', error));
}
function handleEvent(event) {
  if (event.type === 'session.ready') {
    sessionId = event.sessionId;
    $('session-label').textContent = `Session ${sessionId.slice(0, 8)}`;
    socketSend({ type: 'audio.start' });
    return;
  }
  if (event.type === 'audio.ready') {
    recording = true;
    status('Listening', 'good');
    startButton.classList.add('recording');
    startButton.querySelector('span:last-child').textContent =
      'Listening… tap to interrupt';
    stopButton.disabled = false;
    $('control-hint').textContent =
      'Pause to send your turn · Tap the button to interrupt AI audio';
    return;
  }
  if (event.type === 'speech.started') {
    status('Hearing you', 'good');
    return;
  }
  if (event.type === 'transcript.status') {
    status('Transcribing', '');
    return;
  }
  if (event.type === 'transcript.final') {
    addTranscript(event.text);
    status('Thinking', '');
    return;
  }
  if (event.type === 'assistant.text.delta') {
    if (!activeAssistantBubble) activeAssistantBubble = addBubble('assistant');
    activeAssistantBubble.querySelector('.content').textContent += event.text;
    messageList.scrollTop = messageList.scrollHeight;
    status('Speaking', 'good');
    return;
  }
  if (event.type === 'assistant.audio') {
    void playWav(event.audio);
    return;
  }
  if (event.type === 'assistant.turn.end') {
    activeAssistantBubble = undefined;
    status('Listening', 'good');
    return;
  }
  if (event.type === 'turn.interrupted') {
    try {
      currentPlayer?.stop();
    } catch {
      /* already ended */
    }
    currentPlayer = undefined;
    audioQueue = Promise.resolve();
    activeAssistantBubble = undefined;
    status('Listening', 'good');
    return;
  }
  if (event.type === 'error') {
    showNotice(event.message || 'Voice session error.');
    status('Needs attention', 'bad');
    return;
  }
  if (event.type === 'session.ended') {
    if (event.recordingId) void downloadRecording(event.recordingId);
    cleanupUi();
  }
}
async function downloadRecording(id) {
  try {
    const response = await apiFetch(
      `/api/v1/recordings/${encodeURIComponent(id)}`
    );
    if (!response.ok) throw new Error('Could not download the recording.');
    const blobUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = 'micdrop-recording.wav';
    anchor.click();
    URL.revokeObjectURL(blobUrl);
    showNotice('Your microphone recording was saved and downloaded.');
  } catch (error) {
    showNotice(error.message);
  }
}
function startSocket() {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = apiKey
      ? [
          'micdrop',
          `key-${btoa(unescape(encodeURIComponent(apiKey)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '')}`,
        ]
      : ['micdrop'];
    socket = new WebSocket(
      `${scheme}//${location.host}/api/v1/stream`,
      protocols
    );
    socket.onopen = () => {
      socketSend({ type: 'session.start', saveAudio: $('save-audio').checked });
      resolve();
    };
    socket.onmessage = (message) => {
      try {
        handleEvent(JSON.parse(message.data));
      } catch (error) {
        console.error(error);
      }
    };
    socket.onerror = () =>
      reject(new Error('Could not connect to the audio server.'));
    socket.onclose = () => {
      if (recording) cleanupUi();
    };
  });
}
async function start() {
  clearNotice();
  startButton.disabled = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    audioContext = new AudioContext();
    await audioContext.resume();
    await audioContext.audioWorklet.addModule('/pcm-worklet.js');
    source = audioContext.createMediaStreamSource(micStream);
    worklet = new AudioWorkletNode(audioContext, 'pcm-capture', {
      processorOptions: { targetRate: 16000 },
    });
    worklet.port.onmessage = (message) => {
      if (recording && socket?.readyState === WebSocket.OPEN)
        socket.send(message.data);
    };
    source.connect(worklet);
    worklet.connect(audioContext.destination);
    await startSocket();
  } catch (error) {
    showNotice(
      error.message || 'Could not start microphone. Check browser permissions.'
    );
    cleanupUi();
  }
}
function cleanupUi() {
  recording = false;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = undefined;
  try {
    worklet?.disconnect();
    source?.disconnect();
  } catch {
    /* already disconnected */
  }
  worklet = undefined;
  source = undefined;
  if (audioContext) {
    void audioContext.close();
    audioContext = undefined;
  }
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  socket = undefined;
  sessionId = undefined;
  startButton.disabled = false;
  stopButton.disabled = true;
  startButton.classList.remove('recording');
  startButton.querySelector('span:last-child').textContent = 'Start talking';
  $('session-label').textContent = 'No active session';
  $('control-hint').textContent =
    'Microphone permission is requested after you start.';
  status('Ready', '');
}
function stop() {
  if (!recording) return cleanupUi();
  recording = false;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = undefined;
  try {
    worklet?.disconnect();
    source?.disconnect();
  } catch {
    /* already disconnected */
  }
  socketSend({ type: 'session.end' });
  startButton.disabled = true;
  stopButton.disabled = true;
  status('Ending session', '');
}
startButton.addEventListener('click', () => {
  if (!recording) return void start();
  socketSend({ type: 'interrupt' });
  try {
    currentPlayer?.stop();
  } catch {
    /* already ended */
  }
  currentPlayer = undefined;
  audioQueue = Promise.resolve();
  activeAssistantBubble = undefined;
});
stopButton.addEventListener('click', stop);

$('audio-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const result = $('upload-result');
  result.hidden = false;
  result.textContent = `Transcribing ${file.name}…`;
  const form = new FormData();
  form.append('file', file);
  if ($('save-transcript').checked) form.append('persist', 'true');
  try {
    const response = await apiFetch('/api/v1/transcriptions', {
      method: 'POST',
      body: form,
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error?.message || 'Transcription failed.');
    result.replaceChildren();
    const text = document.createElement('p');
    text.textContent = data.text || 'No speech recognized.';
    result.append(text);
    if (data.persisted) {
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = 'Download timestamped VTT';
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        const download = await apiFetch(
          `/api/v1/transcriptions/${encodeURIComponent(data.id)}/export?format=vtt`
        );
        if (!download.ok)
          return showNotice('Could not download the saved transcript.');
        const blobUrl = URL.createObjectURL(await download.blob());
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = 'transcript.vtt';
        anchor.click();
        URL.revokeObjectURL(blobUrl);
      });
      result.append(link);
    } else {
      const hint = document.createElement('span');
      hint.textContent =
        'Not saved. Enable “Save transcript for later” before the next upload to store it.';
      result.append(hint);
    }
  } catch (error) {
    result.textContent = error.message;
  }
  event.target.value = '';
});

async function loadModels() {
  try {
    const response = await apiFetch('/api/v1/models');
    const data = await response.json();
    const list = $('model-list');
    list.replaceChildren();
    for (const provider of data.providers || []) {
      const row = document.createElement('div');
      row.className = 'model-row';
      const name = document.createElement('b');
      name.textContent = provider.name.toUpperCase();
      const state = document.createElement('span');
      state.className = 'model-state';
      const dot = document.createElement('i');
      dot.className = `dot ${provider.reachable ? 'good' : 'bad'}`;
      const label = document.createElement('span');
      label.textContent = provider.reachable ? 'Connected' : 'Offline';
      state.append(dot, label);
      row.append(name, state);
      list.append(row);
    }
    const online = data.providers?.every((item) => item.reachable);
    status(
      online ? 'All models connected' : 'Configure local models',
      online ? 'good' : ''
    );
  } catch {
    status('Server unavailable', 'bad');
  }
}
loadModels();
