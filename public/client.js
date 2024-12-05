const state = {
  connected: false,
  playerActions: [],
  playerId: null,
  playerName: null,
  currentTurnPlayer: null,
  playersYetToAct: [],
  round: 1,
  speechQueue: []
};

let socket;

function submitPlayerForm() {
  const playerName = document.getElementById('playerName').value;
  const playerRace = document.getElementById('playerRace').value;
  const playerClass = document.getElementById('playerClass').value;
  const playerDescription = document.getElementById('playerDescription').value;
  const ability1 = document.getElementById('ability1').value;
  const ability2 = document.getElementById('ability2').value;
  const ability3 = document.getElementById('ability3').value;
  const isNpc = document.getElementById('isNpc').checked;

  if (playerName && playerRace && playerClass && playerDescription && ability1 && ability2 && ability3) {
    const playerData = {
      playerName,
      playerRace,
      playerClass,
      playerDescription,
      abilities: [ability1, ability2, ability3],
      isNpc
    };
    state.playerName = playerName;
    socket.emit('joinGame', playerData);
    document.getElementById('content').innerHTML = '<p>Submitting player data...</p>';
  } else {
    alert('All fields are required to create a new player.');
  }
}

function selectPlayer(playerName) {
  state.playerName = playerName;
  socket.emit('joinGame', { playerName });
  document.getElementById('content').innerHTML = '<p>Joining game...</p>';
}

function sendPlayerAction(action) {
  if (state.connected && state.playerId) {
    socket.emit('playerAction', { action, playerId: state.playerId });
    state.playerActions.push(action);
  } else {
    console.error('Cannot send action, not connected to server or player ID not set');
  }
}

function takeTurn(input) {
  sendPlayerAction({ action: 'takeTurn', content: input });
}

function deleteMessage(threadId, messageId) {
  socket.emit('deleteMessage', { threadId, messageId });
}

function moveToRoom(roomId) {
  if (state.connected && state.playerId) {
    socket.emit('moveToRoom', { playerId: state.playerId, roomId });
  } else {
    console.error('Cannot move to room, not connected to server or player ID not set');
  }
}

function disconnectPlayer() {
  state.playerId = null;
  state.playerName = null;
  socket.emit('requestPlayerList');
}

function initializeEventListeners() {
  // Remove existing event listeners to prevent multiple submissions
  const playerForm = document.querySelector('form[data-action="submitPlayerForm"]');
  if (playerForm) {
    playerForm.removeEventListener('submit', handleSubmitPlayerForm);
    playerForm.addEventListener('submit', handleSubmitPlayerForm);
  }

  const selectPlayerButtons = document.querySelectorAll('button[data-action="selectPlayer"]');
  if (selectPlayerButtons) {
    selectPlayerButtons.forEach(button => {
      button.removeEventListener('click', () => selectPlayer(button.dataset.playerName));
      button.addEventListener('click', () => selectPlayer(button.dataset.playerName));
    });
  }

  const playerInputField = document.getElementById('playerInput');
  if (playerInputField) {
    playerInputField.removeEventListener('input', handlePlayerInput);
    playerInputField.addEventListener('input', handlePlayerInput);
  }

  const playerInput = document.querySelector('form[data-action="takeTurn"]');
  if (playerInput) {
    playerInput.removeEventListener('submit', handleTakeTurn);
    playerInput.addEventListener('submit', handleTakeTurn);
  }

  const disconnectButton = document.querySelector('button[data-action="disconnectPlayer"]');
  if (disconnectButton) {
    disconnectButton.removeEventListener('click', handleDisconnectPlayer);
    disconnectButton.addEventListener('click', handleDisconnectPlayer);
  }

  document.querySelectorAll('button[data-action="deleteMessage"]').forEach(button => {
    button.removeEventListener('click', handleDeleteMessage);
    button.addEventListener('click', handleDeleteMessage);
  });

  const moveToRoom1Button = document.getElementById('moveToRoom1');
  if (moveToRoom1Button) {
    moveToRoom1Button.addEventListener('click', () => moveToRoom('Room1'));
  }

  const moveToRoom2Button = document.getElementById('moveToRoom2');
  if (moveToRoom2Button) {
    moveToRoom2Button.addEventListener('click', () => moveToRoom('Room2'));
  }

  const recordButton = document.getElementById('recordButton');
  if (!recordButton) {
    return;
  }
  recordButton.disabled = state.currentTurnPlayer.id === state.playerId ? false : true;
  recordButton.removeEventListener('mousedown', startRecording);
  recordButton.removeEventListener('mouseup', stopRecording);
  recordButton.removeEventListener('touchstart', startRecording);
  recordButton.removeEventListener('touchend', stopRecording);
  recordButton.addEventListener('mousedown', startRecording);
  recordButton.addEventListener('mouseup', stopRecording);
  recordButton.addEventListener('touchstart', startRecording);
  recordButton.addEventListener('touchend', stopRecording);
}

function handleSubmitPlayerForm(event) {
  event.preventDefault();
  submitPlayerForm();
}

function handlePlayerInput(event) {
  inputText = event.target.value;
}

function handleTakeTurn(event) {
  event.preventDefault();
  let playerText = document.getElementById('playerInput');
  takeTurn(inputText);
  playerText.value = '';
}

function handleDisconnectPlayer() {
  disconnectPlayer();
}

function handleDeleteMessage(event) {
  const threadId = event.target.dataset.threadId;
  const messageId = event.target.dataset.messageId;
  deleteMessage(threadId, messageId);
}

function showLoadingSpinner() {
  const spinner = document.getElementById('loadingSpinner');
  if (spinner) {
    spinner.style.display = 'block';
  }
}

function hideLoadingSpinner() {
  const spinner = document.getElementById('loadingSpinner');
  if (spinner) {
    spinner.style.display = 'none';
  }
}

function playSpeechQueue() {
  if (state.speechQueue.length > 0) {
    const speechFile = state.speechQueue.shift();
    const audioElement = document.createElement('audio');
    audioElement.src = speechFile;
    audioElement.controls = true;
    audioElement.autoplay = true;
    audioElement.onended = () => {
      // audioElement.remove();
      playSpeechQueue();
    };
    document.getElementById('audio').appendChild(audioElement);
  }
}

let mediaRecorder;
let audioChunks = [];

document.addEventListener('DOMContentLoaded', () => {
  socket = io('http://localhost:4000');

  socket.on('connect', () => {
    console.log('Connected to server');
    state.connected = true;
    socket.emit('requestPlayerList');
    socket.emit('requestGameView'); // Request game view and turn information when the page loads
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
    state.connected = false;
  });

  socket.on('narratorResponse', (data) => {
    console.log('Narrator response:', data);
    // Handle narrator response and update state if necessary
  });

  socket.on('playerId', (data) => {
    state.playerId = data.playerId;
    console.log('Received player ID:', state.playerId);
    socket.emit('requestGameView');
  });

  socket.on('playerList', (data) => {
    document.getElementById('content').innerHTML = data.html;
    initializeEventListeners();
  });

  socket.on('playerForm', (data) => {
    document.getElementById('content').innerHTML = data.html;
    initializeEventListeners();
  });

  socket.on('gameView', (data) => {
    let inputText = '';
    let typingInput = document.getElementById('playerInput');
    if (typingInput) {
      inputText = typingInput.value;
    }
    document.getElementById('content').innerHTML = data.html;
    document.getElementById('messages').innerHTML = data.messagesHtml;
    document.getElementById('turnInfo').innerHTML = data.turnInfoHtml;

    state.currentTurnPlayer = data.currentTurnPlayer;
    state.playersYetToAct = data.playersYetToAct;
    state.round = data.round;

    typingInput = document.getElementById('playerInput');
    typingInput.value = inputText;
    state.currentTurnPlayer.id === state.playerId ? typingInput.focus() : typingInput.blur();

    const takeTurnButton = document.getElementById('takeTurnBtn');
    if (takeTurnButton) {
        takeTurnButton.disabled = state.currentTurnPlayer.id === state.playerId ? false : true;
    }

    const whosTurn = document.getElementById('whosTurn');
    if(whosTurn) {
        whosTurn.innerHTML = state.currentTurnPlayer.id === state.playerId ? "It's your turn!" : 'Waiting for ' + state.currentTurnPlayer.name + '...';
    }

    hideLoadingSpinner();
    initializeEventListeners();
  });

  socket.on('update', () => {
    socket.emit('requestGameView');
  });

  socket.on('updateMessages', (data) => {
    document.getElementById('messages').innerHTML = data.messagesHtml;
    hideLoadingSpinner();
    initializeEventListeners();
  });

  socket.on('updateTurnInfo', (data) => {
    document.getElementById('turnInfo').innerHTML = data.turnInfoHtml;

    state.currentTurnPlayer = data.currentTurnPlayer;
    state.playersYetToAct = data.playersYetToAct;
    state.round = data.round;

    const takeTurnButton = document.getElementById('takeTurnBtn');
    if (takeTurnButton) {
        takeTurnButton.disabled = state.currentTurnPlayer.id === state.playerId ? false : true;
    }

    const whosTurn = document.getElementById('whosTurn');
    if(whosTurn) {
        whosTurn.innerHTML = state.currentTurnPlayer.id === state.playerId ? "It's your turn!" : "Waiting for other players...";
    }
  });

  socket.on('showLoadingSpinner', () => {
    showLoadingSpinner();
  });

  socket.on('hideLoadingSpinner', () => {
    hideLoadingSpinner();
  });

  socket.on('playSpeech', (data) => {
    state.speechQueue.push(data.speechFile);
    if (state.speechQueue.length === 1) {
      playSpeechQueue();
    }
  });

  socket.on('uploadError', (data) => {
    console.error('Upload error:', data);
  });

});

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('Media devices not supported');
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  audioChunks = [];
  mediaRecorder.ondataavailable = (event) => {
    audioChunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result;
      socket.emit('uploadAudio', arrayBuffer);
    };
    reader.readAsArrayBuffer(audioBlob);
    audioChunks = [];
  };
  mediaRecorder.start();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

