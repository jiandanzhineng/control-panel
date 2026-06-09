const express = require('express');
const router = express.Router();

// Legacy gameplay routes - kept for backward compatibility
// In the new architecture, games run in the browser and communicate via WebSocket Bridge

router.get('/current/stream', (req, res) => {
  res.status(404).json({ error: 'NO_GAME_RUNNING', message: 'New architecture uses WebSocket Bridge' });
});

router.get('/current/html', (req, res) => {
  res.status(404).json({ error: 'NO_GAME_RUNNING', message: 'Games are now served as static HTML pages' });
});

router.post('/current/actions', (req, res) => {
  res.status(404).json({ error: 'NO_GAME_RUNNING', message: 'New architecture uses WebSocket Bridge' });
});

module.exports = router;
