const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const MarkdownIt = require('markdown-it');
const OpenAI = require('openai');
const multer = require('multer');
const schedule = require('node-schedule');


const app = express();
const server = http.createServer(app);
const io = socketIo(server);

require('dotenv').config();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const md = new MarkdownIt();
const upload = multer({ dest: 'uploads/' });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/client.html');
});

// Ensure the public/audio directory exists
if (!fs.existsSync(path.join(__dirname, 'public/audio'))) {
  fs.mkdirSync(path.join(__dirname, 'public/audio'), { recursive: true });
}

// Function to delete expired audio files
function deleteExpiredAudioFiles() {
const audioFolderPath = path.join(__dirname, 'public/audio');
const expiryTime = 1 * 60 * 60 * 1000; // 24 hours

fs.readdir(audioFolderPath, (err, files) => {
  if (err) throw err;
  const now = Date.now();
  for (const file of files) {
    const filePath = path.join(audioFolderPath, file);
    fs.stat(filePath, (err, stats) => {
      if (err) throw err;
      if (now - stats.mtimeMs > expiryTime) {
        fs.unlink(filePath, err => {
          if (err) throw err;
          console.log(`Deleted expired audio file: ${file}`);
        });
      }
    });
  }
});
}

// Schedule the task to run every hour
schedule.scheduleJob('0 * * * *', deleteExpiredAudioFiles);

function getPromptFromFile(filePath, replacements) {
  let prompt = fs.readFileSync(filePath, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replace(`{${key}}`, value);
  }
  return prompt;
}

// app.post('/upload-audio', upload.single('audio'), async (req, res) => {
//   const audioPath = req.file.path;
//   const newFileName = `audio_${uuidv4()}.webm`;
//   const newFilePath = path.join(__dirname, 'public/audio', newFileName);

//   try {
//       // Move the uploaded file to the public/audio directory
//       fs.rename(audioPath, newFilePath, (err) => {
//           if (err) {
//               console.error('Error moving uploaded file:', err);
//               return res.status(500).send('Error saving audio file');
//           }
//           console.log(`Audio file saved as ${newFileName}`);
//           res.status(200).send({ filePath: `/audio/${newFileName}` });
//       });
//   } catch (error) {
//       console.error('Error handling uploaded audio:', error);
//       res.status(500).send('Error handling uploaded audio');
//   }
// });

// app.post('/upload-audio', upload.single('audio'), async (req, res) => {
//   const audioPath = req.file.path;
//   try {
//       const transcription = await openai.audio.transcriptions.create({
//           file: fs.createReadStream(audioPath),
//           model: 'whisper-1',
//       });
//       console.log(transcription.text);
//       // Create a message with the transcribed text
//       await createMessage('thread_lgsRHFbLxMMMETSCR8AubYDY', 'user', transcription.text, { name: req.body.playerName });
//       res.status(200).send({ text: transcription.text });
//   } catch (error) {
//       console.error('Error transcribing audio:', error);
//       res.status(500).send('Error transcribing audio');
//   } finally {
//       // Clean up the uploaded file
//       fs.unlink(audioPath, (err) => {
//           if (err) console.error('Error deleting uploaded file:', err);
//       });
//   }
// });

async function listMessages(threadId) {
    const threadMessages = await openai.beta.threads.messages.list(threadId);
    return threadMessages.data;
}

async function createMessage(threadId, role, content, metadata = null) {
    if(metadata.name) {
      content = metadata.name + ': ' + content;
    }
    const threadMessages = await openai.beta.threads.messages.create(threadId, { role: role, content: content, metadata: metadata });
    console.log(threadMessages);
}

let speechBoolean = true;

async function createSpeech(text, voice = "alloy") {
    if (!speechBoolean) {
        return;
    }

    const speechFile = path.resolve(__dirname, 'public/audio', `${uuidv4()}.mp3`);
    const mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice: voice,
        input: text,
        speed: 1.2
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    await fs.promises.writeFile(speechFile, buffer);
    return `/audio/${path.basename(speechFile)}`;
}

async function transcribeAudio(filePath) {
    const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1"
    });
    return transcription.text;
}

async function deleteMessage(threadId, messageId) {
    io.emit('showLoadingSpinner');
    const deletedMessage = await openai.beta.threads.messages.del(threadId, messageId);
    io.emit('hideLoadingSpinner');
    console.log("Deleted message: " + deletedMessage);
}

async function logMessages(threadId) {
    try {
        const messages = await listMessages(threadId);
        if (messages.length == 0) {
            console.log("No messages");
            return;
        }
        messages.forEach(message => {
            console.log(message.role, message.content, message.metadata);
        });
    } catch (error) {
        console.error('Error listing messages:', error);
    }
}

async function renderMessages(threadId) {
    try {
        const messages = await listMessages(threadId);
        return messages.map(message => ({
            role: message.metadata.name ? message.metadata.name : message.role,
            content: md.render(message.content[0].text.value),
            id: message.id
        }));
    } catch (error) {
        console.error('Error rendering messages:', error);
        return [];
    }
}

async function runThread(threadId, assistantId, instructions) {
    let run = await openai.beta.threads.runs.createAndPoll(threadId, {
        assistant_id: assistantId,
        instructions: instructions,
        model: 'gpt-4o-mini'
    });

    if (run.status === 'completed') {
        const messages = await listMessages(run.thread_id);
        return messages.map(message => ({
            role: message.role,
            content: md.render(message.metadata.name ? `${message.metadata.name}: ` : ''  + message.content[0].text.value),
            id: message.id
        }));
    } else {
        console.log(run.status);
        return [];
    }
}

// deleteMessage('thread_lgsRHFbLxMMMETSCR8AubYDY','msg_BMXSegE3VlfnlebnFbH1OOg0')

logMessages('thread_lgsRHFbLxMMMETSCR8AubYDY');

const rooms = {
  'Room1': {
    id: 'Room1',
    name: 'Bedroom',
    description: 'A simple room with stone walls.',
    players: [],
    exits: ['Courtyard', 'Kitchen', 'Hallway']
  },
  'Room2': {
    id: 'Room2',
    name: 'Courtyard',
    description: 'A spacious courtyard with a fountain.',
    players: [],
    exits: ['Bedroom']
  }
};

const testPlayerId1 = uuidv4();
const testPlayerId2 = uuidv4();
const testNpcId = uuidv4();
const players = {
  [testPlayerId1]: {
    id: testPlayerId1,
    name: 'Gerald',
    race: 'Human',
    class: 'Warrior',
    description: 'A slender warrior with supple curves. Has a hook nose.',
    abilities: ['Slash', 'Block', 'Charge'],
    actions: [],
    room: rooms['Room1'],
    isNpc: false
  },
  [testPlayerId2]: {
    id: testPlayerId2,
    name: 'Godfrick',
    race: 'Elf',
    class: 'Mage',
    description: 'A wise mage. Aloof, and oddly perverted.',
    abilities: ['Fireball', 'Teleport', 'Shield'],
    actions: [],
    room: rooms['Room2'],
    isNpc: false
  },
  [testNpcId]: {
    id: testNpcId,
    name: 'Grog',
    race: 'Orc',
    class: 'Guard',
    description: 'A strong guard. Beneath a solemn surface, a streak of sexual deviancy and a lifetime of regret.',
    abilities: ['Smash', 'Roar', 'Defend'],
    actions: [],
    room: rooms['Room1'],
    isNpc: true
  }
};

rooms['Room1'].players.push(players[testPlayerId1]);
rooms['Room1'].players.push(players[testNpcId]);
rooms['Room2'].players.push(players[testPlayerId2]);

function getSimplifiedGameState() {
  const allPlayers = Object.values(players);
  const humanPlayers = allPlayers.filter(player => !player.isNpc);
  const npcPlayers = allPlayers.filter(player => player.isNpc);

  const activeRooms = Object.values(rooms).filter(room => room.players.some(player => !player.isNpc));
  const activeNpcs = npcPlayers.filter(npc => activeRooms.some(room => room.players.includes(npc)));

  const simplifiedPlayers = Object.values(humanPlayers.concat(activeNpcs)).map(player => ({
    id: player.id,
    name: player.name,
    race: player.race,
    class: player.class,
    description: player.description,
    abilities: player.abilities,
    room: player.room.id,
    isNpc: player.isNpc
  }));

  const simplifiedRooms = Object.values(activeRooms).map(room => ({
    id: room.id,
    name: room.name,
    description: room.description,
    players: room.players.map(player => player.name),
    exits: room.exits
  }));

  return {
    players: simplifiedPlayers,
    rooms: simplifiedRooms
  };
}

let currentTurnIndex = 0;
let round = 1;

async function getNextTurn() {
  const allPlayers = Object.values(players);
  const humanPlayers = allPlayers.filter(player => !player.isNpc);
  const npcPlayers = allPlayers.filter(player => player.isNpc);

  const activeRooms = Object.values(rooms).filter(room => room.players.some(player => !player.isNpc));
  const activeNpcs = npcPlayers.filter(npc => activeRooms.some(room => room.players.includes(npc)));

  const currentPlayer = humanPlayers[currentTurnIndex];
  currentTurnIndex = (currentTurnIndex + 1) % humanPlayers.length;
  if (currentTurnIndex === 0) {

    const simplifiedGameState = getSimplifiedGameState();

    // Perform npc actions
    for (const npc of activeNpcs) {
      io.emit('showLoadingSpinner');

      const npcPrompt = getPromptFromFile('npc_prompt.txt', {
        name: npc.name,
        race: npc.race,
        class: npc.class,
        description: npc.description,
        room: npc.room.name,
        gameState: JSON.stringify(simplifiedGameState)
      });

      // Run the AI thread to create a response
      const messages = await runThread('thread_lgsRHFbLxMMMETSCR8AubYDY', 'asst_aEviTxzsirncQ4QaKlwjvbPl', npcPrompt);
      // let latestMessage = messages.reverse().find(message => message.role === 'assistant');
      // if (latestMessage) {
      //   await modifyMessage('thread_lgsRHFbLxMMMETSCR8AubYDY', latestMessage.id, { metadata: { name: npc.name } });
      // }
      app.render('messages', { messages: messages.reverse() }, async (err, messagesHtml) => {
        if (err) throw err;
        io.emit('updateMessages', { messagesHtml });
      });

      // Create speech for NPC action asynchronously
      createSpeech(messages.reverse()[0].content, "echo").then(npcSpeechFile => {
        console.log(npcSpeechFile);
        if (npcSpeechFile)
        io.emit('playSpeech', { speechFile: npcSpeechFile });
      }).catch(err => {
        console.error('Error creating NPC speech:', err);
      });
    }

    round++;
    console.log(`Round ${round} begins`);

    humanPlayers.forEach(human => {
      human.actions = [];
    });

    // Emit event to show loading spinner
    io.emit('showLoadingSpinner');

    const narratorPrompt = getPromptFromFile('narrator_prompt.txt', {
      gameState: JSON.stringify(simplifiedGameState)
    });

    console.log('Game state:', JSON.stringify(simplifiedGameState));
    // Run the AI thread to create a response
    const messages = await runThread('thread_lgsRHFbLxMMMETSCR8AubYDY', 'asst_TzsYQHg1B8yg7Uo4zGfh4nUK', narratorPrompt);
    app.render('messages', { messages: messages.reverse() }, (err, messagesHtml) => {
      if (err) throw err;
      io.emit('updateMessages', { messagesHtml });
    });

    // Create speech for narrator asynchronously
    createSpeech(messages.reverse()[0].content, "onyx").then(narratorSpeechFile => {
      io.emit('playSpeech', { speechFile: narratorSpeechFile });
    }).catch(err => {
      console.error('Error creating narrator speech:', err);
    });
  }
  return currentPlayer;
}

function getPlayersYetToAct() {
  const allPlayers = Object.values(players);
  const humanPlayers = allPlayers.filter(player => !player.isNpc);
  const npcPlayers = allPlayers.filter(player => player.isNpc);
  return humanPlayers.slice(currentTurnIndex).concat(npcPlayers);
}

io.on('connection', async (socket) => {
  console.log('New client connected');

  socket.on('disconnect', () => {
    console.log('Client disconnected');
    // Optionally handle player disconnection logic
  });

  socket.on('uploadAudio', async (arrayBuffer) => {
    //only accept the file if it is the current player's turn
    const currentPlayer = Object.values(players)[currentTurnIndex];
    if (currentPlayer.id !== socket.playerId) {
      console.error(`${players[socket.playerId].name} tried to upload audio out of turn`);
      socket.emit('uploadError', 'It is not your turn');
      return;
    }

    const newFileName = `audio_${uuidv4()}.webm`;
    const newFilePath = path.join(__dirname, 'public/audio', newFileName);

    fs.writeFile(newFilePath, Buffer.from(arrayBuffer), async (err) => {
      if (err) {
        console.error('Error saving audio file:', err);
        socket.emit('uploadError', 'Error saving audio file');
      } else {
        console.log(`Audio file saved as ${newFileName}`);

        try {
          // Transcribe the audio using OpenAI's Whisper model
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(newFilePath),
            model: 'whisper-1',
          });
          console.log('Transcription:', transcription.text);

          const playerName = players[socket.playerId].name;

          // Create a message with the transcribed text
          await createMessage('thread_lgsRHFbLxMMMETSCR8AubYDY', 'user', transcription.text, { name: playerName });

          // socket.emit('uploadSuccess', { filePath: `/audio/${newFileName}`, transcription: transcription.text });
          
          //player has taken their turn, now it's the next player's turn\
          const nextPlayer = await getNextTurn();
          console.log(`It's now ${nextPlayer.name}'s turn`);

          io.emit('update');
          
        } catch (error) {
          console.error('Error transcribing audio:', error);
          socket.emit('uploadError', 'Error transcribing audio');
        }
      }
    });
  });

  socket.on('requestPlayerList', () => {
    const playerList = Object.values(players).map(player => ({ name: player.name, race: player.race, class: player.class, description: player.description, isNpc: player.isNpc }));
    app.render('playerList', { players: playerList }, (err, html) => {
      if (err) throw err; 
      socket.emit('playerList', { html });
    });
  });

  socket.on('requestPlayerForm', () => {
    app.render('playerForm', {}, (err, html) => {
      if (err) throw err;
      socket.emit('playerForm', { html });
    });
  });

  socket.on('joinGame', (data) => {
    const { playerName, playerRace, playerClass, playerDescription, abilities, isNpc } = data;
    let playerId = uuidv4();
    if (!Object.values(players).some(player => player.name === playerName)) {
      players[playerId] = { id: playerId, name: playerName, race: playerRace, class: playerClass, description: playerDescription, abilities, actions: [], room: rooms['Room1'], isNpc };
      rooms['Room1'].players.push(players[playerId]);
      console.log(`Player ${playerName} joined the game with ID ${playerId}`);
    } else {
      playerId = Object.values(players).find(player => player.name === playerName).id;
    }
    socket.playerId = playerId;
    socket.emit('playerId', { playerId });
    // sendTurnInfo();
  });

  socket.on('requestGameView', async () => {
    const player = players[socket.playerId];
    if (player) {
      const room = player.room;
      const currentPlayer = Object.values(players)[currentTurnIndex];
      app.render('gameView', { room, player }, async (err, html) => {
        if (err) throw err;
        const messages = await renderMessages('thread_lgsRHFbLxMMMETSCR8AubYDY');
        app.render('messages', { messages: messages.reverse() }, (err, messagesHtml) => {
          if (err) throw err;
          app.render('turnInfo', {
            player,
            currentTurnPlayer: currentPlayer ? currentPlayer.name : 'None',
            playersYetToAct: getPlayersYetToAct().map(p => p.name),
            round
          }, (err, turnInfoHtml) => {
            if (err) throw err;
            socket.emit('gameView', {
              html,
              messagesHtml,
              turnInfoHtml,
              player: { id: player.id, name: player.name, race: player.race, class: player.class, description: player.description },
              currentTurnPlayer: currentPlayer ? { id: currentPlayer.id, name: currentPlayer.name } : null,
              playersYetToAct: getPlayersYetToAct().map(p => ({ id: p.id, name: p.name })),
              round
            });
          });
        });
      });
    }
  });

  socket.on('playerAction', async (data) => {
    const { playerId, action } = data;
    const player = players[playerId];
    if (player) {
      switch (action.action) {
        case 'takeTurn':
          const currentPlayer = Object.values(players)[currentTurnIndex];
          if (currentPlayer.id === playerId) {
            console.log(`Player action received from ${player.name}:`, action);
            player.actions.push(action);
            // Create a new message using the player's name as metadata and the player text input as the content
            await createMessage('thread_lgsRHFbLxMMMETSCR8AubYDY', 'user', action.content, { name: player.name });
            // Broadcast to other clients or handle game logic
            io.emit('narratorResponse', { message: 'Narrator response' });

            // Refresh client messages
            const messages = await renderMessages('thread_lgsRHFbLxMMMETSCR8AubYDY');
            app.render('messages', { messages: messages.reverse() }, (err, messagesHtml) => {
              if (err) throw err;
              io.emit('updateMessages', { messagesHtml });
            });

            // Get the next turn
            const nextPlayer = await getNextTurn();
            console.log(`It's now ${nextPlayer.name}'s turn`);

            // Send turn and round information to all clients
            app.render('turnInfo', {
              currentTurnPlayer: nextPlayer ? nextPlayer.name : 'None',
              playersYetToAct: getPlayersYetToAct().map(p => p.name),
              round
            }, (err, turnInfoHtml) => {
              if (err) throw err;
              io.emit('updateTurnInfo', {
                turnInfoHtml,
                currentTurnPlayer: nextPlayer ? { id: nextPlayer.id, name: nextPlayer.name } : null,
                playersYetToAct: getPlayersYetToAct().map(p => ({ id: p.id, name: p.name })),
                round
              });
            });
          } else {
            console.error(`Player with ID ${playerId} tried to take a turn out of order`);
          }
          io.emit('update');
          break;
        default:
          console.log(`Player action received from ${player.name}:`, action);
          player.actions.push(action);
          // Broadcast to other clients or handle game logic
          io.emit('narratorResponse', { message: 'Narrator response' });
          break;
      }
    } else {
      console.error(`Player with ID ${playerId} not found`);
    }
  });

  socket.on('deleteMessage', async (data) => {
    const { threadId, messageId } = data;
    try {
      await deleteMessage(threadId, messageId);
      const messages = await renderMessages(threadId);
      app.render('messages', { messages: messages.reverse() }, (err, messagesHtml) => {
        if (err) throw err;
        io.emit('updateMessages', { messagesHtml });
      });
    } catch (error) {
      console.error('Error deleting message:', error);
    }
  });

  socket.on('moveToRoom', async (data) => {
    const { playerId, roomId } = data;
    const player = players[playerId];
    if (player && rooms[roomId]) {
      const oldRoom = player.room;
      const newRoom = rooms[roomId];
      oldRoom.players = oldRoom.players.filter(p => p.id !== playerId);
      newRoom.players.push(player);
      player.room = newRoom;
      console.log(`Player ${player.name} moved to ${newRoom.name}`);
      player.actions.push({ action: 'moveToRoom', content: `Moved to ${newRoom.name}` });

      // Notify the client to update the game view
      const currentPlayer = Object.values(players)[currentTurnIndex];
      app.render('gameView', { room: newRoom, player }, async (err, html) => {
        if (err) throw err;
        const messages = await renderMessages('thread_lgsRHFbLxMMMETSCR8AubYDY');
        app.render('messages', { messages: messages.reverse() }, (err, messagesHtml) => {
          if (err) throw err;
          app.render('turnInfo', {
            player,
            currentTurnPlayer: currentPlayer ? currentPlayer.name : 'None',
            playersYetToAct: getPlayersYetToAct().map(p => p.name),
            round
          }, (err, turnInfoHtml) => {
            if (err) throw err;
            socket.emit('gameView', {
              html,
              messagesHtml,
              turnInfoHtml,
              player: { id: player.id, name: player.name, race: player.race, class: player.class, description: player.description },
              currentTurnPlayer: currentPlayer ? { id: currentPlayer.id, name: currentPlayer.name } : null,
              playersYetToAct: getPlayersYetToAct().map(p => ({ id: p.id, name: p.name })),
              round
            });
          });
        });
      });
    } else {
      console.error(`Player with ID ${playerId} or Room with ID ${roomId} not found`);
    }
    io.emit('update');

  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));