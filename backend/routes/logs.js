const express = require('express');
const fs = require('fs');
const logService = require('../services/logService');

const router = express.Router();

router.get('/current', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const onNewLog = (logData) => {
    res.write(`data: ${JSON.stringify(logData)}\n\n`);
  };

  logService.on('newLog', onNewLog);

  req.on('close', () => {
    logService.removeListener('newLog', onNewLog);
  });
});

router.get('/files', (req, res) => {
  try {
    const files = logService.getLogFiles();
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: '获取日志文件列表失败' });
  }
});

router.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  
  if (!filename.endsWith('.log')) {
    return res.status(400).json({ error: '无效的文件名' });
  }

  try {
    const filePath = logService.getLogFilePath(filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    res.download(filePath, filename);
  } catch (error) {
    res.status(500).json({ error: '下载文件失败' });
  }
});

module.exports = router;