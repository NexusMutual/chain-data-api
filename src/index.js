require('dotenv').config();
const routes = require('./routes');

const {
  PORT,
} = process.env;

async function startServer (app, port) {
  return new Promise(resolve => app.listen(port, resolve));
}

async function init () {
  const app = routes();
  await startServer(app, PORT);

  console.log(`Quote engine listening on port ${PORT}`);
}

init()
  .catch(error => {
    console.error('Unhandled app error:', error);
    process.exit(1);
  });
