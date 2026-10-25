const { createQuitCoordinator } = require('../../electron/shutdownCoordinator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Electron quit coordinator', () => {
  it('waits for one backend shutdown before allowing Electron to quit', async () => {
    const pending = deferred();
    const app = { quit: jest.fn() };
    const shutdown = jest.fn(() => pending.promise);
    const onError = jest.fn();
    const coordinator = createQuitCoordinator({ app, shutdown, onError, timeoutMs: 5000 });
    const firstEvent = { preventDefault: jest.fn() };
    const duplicateEvent = { preventDefault: jest.fn() };

    coordinator.handleBeforeQuit(firstEvent);
    coordinator.handleBeforeQuit(duplicateEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(duplicateEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();

    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onError).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledTimes(1);

    const finalEvent = { preventDefault: jest.fn() };
    coordinator.handleBeforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('reports a timeout and still releases the application exit', async () => {
    jest.useFakeTimers();
    const app = { quit: jest.fn() };
    const onError = jest.fn();
    const coordinator = createQuitCoordinator({
      app,
      shutdown: () => new Promise(() => {}),
      onError,
      timeoutMs: 50,
    });

    coordinator.handleBeforeQuit({ preventDefault: jest.fn() });
    await jest.advanceTimersByTimeAsync(50);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ELECTRON_SHUTDOWN_TIMEOUT' }));
    expect(app.quit).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('starts the update installer only after application shutdown has finished', async () => {
    const pending = deferred();
    const app = { quit: jest.fn() };
    const installUpdate = jest.fn();
    const coordinator = createQuitCoordinator({
      app,
      shutdown: () => pending.promise,
      timeoutMs: 5000,
    });

    coordinator.quitAfterShutdown(installUpdate);

    expect(installUpdate).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();

    const updaterQuitEvent = { preventDefault: jest.fn() };
    coordinator.handleBeforeQuit(updaterQuitEvent);
    expect(updaterQuitEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the window alive until application shutdown has finished', async () => {
    const pending = deferred();
    const app = { quit: jest.fn() };
    const coordinator = createQuitCoordinator({
      app,
      shutdown: () => pending.promise,
      timeoutMs: 5000,
    });
    const initialClose = { preventDefault: jest.fn() };
    coordinator.handleWindowClose(initialClose);
    expect(initialClose.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);

    coordinator.handleBeforeQuit({ preventDefault: jest.fn() });
    const closeDuringShutdown = { preventDefault: jest.fn() };
    coordinator.handleWindowClose(closeDuringShutdown);
    expect(closeDuringShutdown.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);

    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.quit).toHaveBeenCalledTimes(2);

    const finalClose = { preventDefault: jest.fn() };
    coordinator.handleWindowClose(finalClose);
    expect(finalClose.preventDefault).not.toHaveBeenCalled();
  });

  it('hides to tray instead of quitting when close-to-tray is enabled', () => {
    const app = { quit: jest.fn() };
    const onHideToTray = jest.fn();
    const coordinator = createQuitCoordinator({
      app,
      shutdown: jest.fn(),
      shouldHideToTray: () => true,
      onHideToTray,
    });
    const event = { preventDefault: jest.fn() };

    coordinator.handleWindowClose(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onHideToTray).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
  });
});
