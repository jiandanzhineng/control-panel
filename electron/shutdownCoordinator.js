function timeoutError(timeoutMs) {
  const error = new Error(`Electron shutdown timed out after ${timeoutMs}ms`);
  error.code = 'ELECTRON_SHUTDOWN_TIMEOUT';
  return error;
}

function createQuitCoordinator({
  app,
  shutdown,
  onError = () => {},
  timeoutMs = 5000,
  shouldHideToTray = () => false,
  onHideToTray = () => {},
}) {
  let allowQuit = false;
  let shutdownPromise = null;

  function shutdownThen(onReadyToQuit = () => app.quit()) {
    if (allowQuit) {
      onReadyToQuit();
      return shutdownPromise || Promise.resolve();
    }
    if (shutdownPromise) return shutdownPromise;

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
        onReadyToQuit();
      });

    return shutdownPromise;
  }

  function handleBeforeQuit(event) {
    if (allowQuit) return;
    event.preventDefault();
    shutdownThen();
  }

  function handleWindowClose(event) {
    if (allowQuit) return;
    event.preventDefault();
    if (shouldHideToTray()) {
      onHideToTray();
      return;
    }
    if (!shutdownPromise) app.quit();
  }

  return {
    handleBeforeQuit,
    handleWindowClose,
    quitAfterShutdown: (onReadyToQuit) => shutdownThen(onReadyToQuit),
  };
}

module.exports = { createQuitCoordinator };
