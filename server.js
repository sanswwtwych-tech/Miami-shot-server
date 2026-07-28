function resetMatch(room) {
  room.scores = [0, 0];
  room.speed = TICK_MS;
  room.paused = false;
  room.gameOver = false;
  // Cantos opostos: P1 superior-esquerdo → direita, P2 inferior-direito → esquerda
  room.snakes = [
    {
      body: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
      ],
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      alive: true,
      skin: room.players[0]?.skin || defaultSkin(0),
    },
    {
      body: [
        { x: COLS - 3, y: ROWS - 3 },
        { x: COLS - 2, y: ROWS - 3 },
        { x: COLS - 1, y: ROWS - 3 },
      ],
      dir: { x: -1, y: 0 },
      nextDir: { x: -1, y: 0 },
      alive: true,
      skin: room.players[1]?.skin || defaultSkin(1),
    },
  ];
  spawnFood(room);
}
