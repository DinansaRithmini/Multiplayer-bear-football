/*
 * Multiplayer Goal Ball Game Server
 *
 * This Node.js server powers a simple real‑time multiplayer game inspired
 * by arena shooters like Brawl Stars. Two teams compete to collect
 * footballs hidden around the map and score goals at opposite ends of
 * the field. The authoritative game state lives on the server: positions
 * of players, balls and scores. Clients connect over WebSockets and
 * receive regular state updates. They send movement commands back to
 * the server. Keeping the logic here ensures fair play and synchronised
 * gameplay.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');

// Configuration constants
const PORT = process.env.PORT || 3000;
const TICK_RATE = 1000 / 30; // 30 updates per second
const WORLD_WIDTH = 800; // size of the play area in world units (increased for larger field)
const WORLD_HEIGHT = 600;  // size of the play area in world units (increased for larger field)
const PLAYER_SPEED = 3; // units per tick
const BALL_RADIUS = 3;
const PLAYER_RADIUS = 5;
const BALL_COUNT = 5;

// Goals: two scoring zones at opposite ends of the map
const GOAL_WIDTH = 60;
const GOAL_DEPTH = 20;

// Teams
const TEAMS = ['left', 'right'];

// Helper to generate a random coordinate inside the field
function randInField() {
  return {
    x: Math.random() * WORLD_WIDTH - WORLD_WIDTH / 2,
    y: Math.random() * WORLD_HEIGHT - WORLD_HEIGHT / 2,
  };
}

// Create a new ball at a random position (we'll later hide them under bushes on client)
function createBall() {
  const pos = randInField();
  return {
    id: uuidv4(),
    x: pos.x,
    y: pos.y,
    carriedBy: null, // which player id is currently carrying this ball
  };
}

// Create a new player object
function createPlayer(id, team) {
  // Spawn near your own goal
  const spawnX = team === 'left' ? -WORLD_WIDTH / 2 + 40 : WORLD_WIDTH / 2 - 40;
  const spawnY = 0;
  return {
    id,
    team,
    x: spawnX,
    y: spawnY,
    dirX: 0,
    dirY: 0,
    score: 0,
    carryingBallId: null,
  };
}

// Check if a point is inside a team's goal
function isInGoal(team, x, y) {
  if (team === 'left') {
    // Left goal is on the left edge
    return x < -WORLD_WIDTH / 2 + GOAL_DEPTH && Math.abs(y) < GOAL_WIDTH / 2;
  } else {
    // Right goal is on the right edge
    return x > WORLD_WIDTH / 2 - GOAL_DEPTH && Math.abs(y) < GOAL_WIDTH / 2;
  }
}

// Calculate squared distance between two points
function dist2(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

// Game state
const players = new Map(); // id -> player object
const balls = new Map(); // id -> ball object
let nextTeamIndex = 0; // rotate teams on join

// Initialise balls
for (let i = 0; i < BALL_COUNT; i++) {
  const ball = createBall();
  balls.set(ball.id, ball);
}

/**
 * Main update loop. Moves players based on their input, handles collisions
 * with balls and goals, and broadcasts the state to all clients.
 */
function update() {
  // Move players
  for (const player of players.values()) {
    if (player.dirX !== 0 || player.dirY !== 0) {
      // Normalise direction to prevent faster diagonal movement
      const mag = Math.sqrt(player.dirX * player.dirX + player.dirY * player.dirY);
      const nx = player.dirX / mag;
      const ny = player.dirY / mag;
      player.x += nx * PLAYER_SPEED;
      player.y += ny * PLAYER_SPEED;

      // Constrain to world bounds
      player.x = Math.max(-WORLD_WIDTH / 2 + PLAYER_RADIUS, Math.min(WORLD_WIDTH / 2 - PLAYER_RADIUS, player.x));
      player.y = Math.max(-WORLD_HEIGHT / 2 + PLAYER_RADIUS, Math.min(WORLD_HEIGHT / 2 - PLAYER_RADIUS, player.y));
    }

    // If carrying a ball, update ball position to follow
    if (player.carryingBallId) {
      const ball = balls.get(player.carryingBallId);
      if (ball) {
        ball.x = player.x;
        ball.y = player.y;
      }
    }

    // Check for scoring: if player is in their own goal while carrying a ball
    if (player.carryingBallId && isInGoal(player.team, player.x, player.y)) {
      // Score!
      player.score += 1;
      const scoredBallId = player.carryingBallId;
      player.carryingBallId = null;
      const oldBall = balls.get(scoredBallId);
      if (oldBall) {
        // Respawn ball somewhere else
        balls.delete(scoredBallId);
        const newBall = createBall();
        balls.set(newBall.id, newBall);
      }
    }
  }

  // Collision detection: players pick up nearby balls if not carrying
  for (const player of players.values()) {
    if (player.carryingBallId) continue;
    for (const ball of balls.values()) {
      if (ball.carriedBy) continue; // already carried
      const d2 = dist2(player.x, player.y, ball.x, ball.y);
      const pickupRange = (PLAYER_RADIUS + BALL_RADIUS) ** 2;
      if (d2 < pickupRange) {
        // Pick up ball
        player.carryingBallId = ball.id;
        ball.carriedBy = player.id;
        break;
      }
    }
  }

  // Collision detection: players bump into each other and drop balls
  const playersArray = Array.from(players.values());
  for (let i = 0; i < playersArray.length; i++) {
    const p1 = playersArray[i];
    for (let j = i + 1; j < playersArray.length; j++) {
      const p2 = playersArray[j];
      const d2 = dist2(p1.x, p1.y, p2.x, p2.y);
      const collisionDist2 = (PLAYER_RADIUS * 2) ** 2;
      if (d2 < collisionDist2) {
        // If players collide, they bounce slightly apart and drop any carried balls
        // Simple separation vector
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const mag = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const overlap = Math.sqrt(collisionDist2 - d2) / 2;
        const nx = dx / mag;
        const ny = dy / mag;
        p1.x += nx * overlap;
        p1.y += ny * overlap;
        p2.x -= nx * overlap;
        p2.y -= ny * overlap;

        // Drop balls
        if (p1.carryingBallId) {
          const ball = balls.get(p1.carryingBallId);
          if (ball) {
            ball.carriedBy = null;
          }
          p1.carryingBallId = null;
        }
        if (p2.carryingBallId) {
          const ball = balls.get(p2.carryingBallId);
          if (ball) {
            ball.carriedBy = null;
          }
          p2.carryingBallId = null;
        }
      }
    }
  }

  // Broadcast state
  broadcastState();
}

/**
 * Send the current game state to all connected clients.
 */
function broadcastState() {
  const payload = {
    type: 'state',
    players: [],
    balls: [],
  };
  for (const player of players.values()) {
    payload.players.push({
      id: player.id,
      team: player.team,
      x: player.x,
      y: player.y,
      score: player.score,
    });
  }
  for (const ball of balls.values()) {
    payload.balls.push({
      id: ball.id,
      x: ball.x,
      y: ball.y,
      carriedBy: ball.carriedBy,
    });
  }
  const msg = JSON.stringify(payload);
  for (const { ws } of players.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// Setup Express HTTP server
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer });

// Handle new connections
wss.on('connection', (ws) => {
  // Assign team in round robin fashion
  const team = TEAMS[nextTeamIndex % TEAMS.length];
  nextTeamIndex += 1;
  const id = uuidv4();
  const player = createPlayer(id, team);
  players.set(id, { ws, ...player });

  // Send initial message with id and team
  ws.send(JSON.stringify({ type: 'init', id, team }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') {
        const player = players.get(id);
        if (player) {
          // Input is a direction vector; clamp values to [-1,1]
          let { x, y } = msg;
          x = Math.max(-1, Math.min(1, x));
          y = Math.max(-1, Math.min(1, y));
          player.dirX = x;
          player.dirY = y;
        }
      }
    } catch (err) {
      console.error('Invalid message', err);
    }
  });

  ws.on('close', () => {
    players.delete(id);
  });
});

// Start game loop
setInterval(update, TICK_RATE);

// Start listening
httpServer.listen(PORT, () => {
  console.log(`Goal Ball server listening on port ${PORT}`);
});