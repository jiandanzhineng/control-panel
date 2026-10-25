const guardedStreams = new WeakSet();

function handleStdioError(error) {
  if (error?.code === 'EPIPE') return;
  throw error;
}

function guardStream(stream) {
  if (!stream || typeof stream.on !== 'function' || guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  stream.on('error', handleStdioError);
}

function installStdioErrorGuards({
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  guardStream(stdout);
  guardStream(stderr);
}

module.exports = {
  handleStdioError,
  installStdioErrorGuards,
};
