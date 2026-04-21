// CoreX Bridge — entry point.
// Toda la lógica vive en src/. Este archivo existe para no romper
// corex.config.js (PM2) ni scripts externos que invocan `node server.js`.

require('./src/index');
