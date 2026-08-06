function timeoutError(timeoutMs) {
  const error = new Error(`Electron shutdown timed out after ${timeoutMs}ms`);
  error.code = 'ELECTRON_SHUTDOWN_TIMEOUT';
  return error;
}

function createQuitCoordinator({ app, shutdown, onError = () => {}, timeoutMs = 5000 }) {
  let allowQuit = false;
  let shutdownPromise = null;

  function handleBeforeQuit(event) {
    if (allowQuit) return;
    event.preventDefault();
    if (shutdownPromise) return;

    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
    });

    let shutdownResult;
    try {
      shutdownResult = shutdown();
    } catch (error) {
      shutdownResult = Promise.reject(error);
    }

    shutdownPromise = Promise.race([
      Promise.resolve(shutdownResult),
      deadline,
    ])
      .catch((error) => onError(error))
      .finally(() => {
        clearTimeout(timeout);
        allowQuit = true;
        app.quit();
      });
  }

  function handleWindowClose(event) {
    if (allowQuit) return;
    event.preventDefault();
    if (!shutdownPromise) app.quit();
  }

  return { handleBeforeQuit, handleWindowClose };
}

module.exports = { createQuitCoordinator };
