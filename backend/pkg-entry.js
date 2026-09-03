'use strict';

// Entry point for the packaged CineBook desktop build (@yao-pkg/pkg).
// Finds a free port, starts the Express server (which seeds the DB if empty),
// prints the URL, and opens it in the default browser.

const { spawn } = require('child_process');
const { app, PORT: DEFAULT_PORT } = require('./server');

// Try to listen on `port`; on EADDRINUSE walk forward, then fall back to an
// OS-assigned port. Resolves with the http.Server once it is listening.
function listenOnFreePort(preferred, maxTries = 25) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryPort = (port) => {
      const server = app.listen(port);
      server.once('listening', () => {
        server.removeAllListeners('error');
        resolve(server);
      });
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          attempt += 1;
          if (attempt < maxTries) return tryPort(port === 0 ? 0 : preferred + attempt);
          if (port !== 0) return tryPort(0); // let the OS choose
        }
        reject(err);
      });
    };

    tryPort(preferred);
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* the user can still open the URL manually */
  }
}

(async () => {
  const preferred = Number(process.env.PORT) || DEFAULT_PORT || 4000;
  const server = await listenOnFreePort(preferred);
  const port = server.address().port;
  const url = `http://localhost:${port}/`;

  console.log('');
  console.log('  ===============================================');
  console.log('   CineBook is running.');
  console.log('   Open:  ' + url);
  console.log('');
  console.log('   Keep this window open while you use CineBook.');
  console.log('   Close it (or press Ctrl+C) to stop.');
  console.log('  ===============================================');
  console.log('');

  setTimeout(() => openBrowser(url), 600);
})().catch((err) => {
  console.error('CineBook failed to start:', err && err.message ? err.message : err);
  console.error('\nPress Enter to close.');
  try {
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } catch {
    process.exit(1);
  }
});
