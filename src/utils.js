const log = require('./log');

const hex = string => '0x' + Buffer.from(string).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function chunk (arr, chunkSize) {
  const chunks = [];
  let i = 0;
  const n = arr.length;

  while (i < n) {
    chunks.push(arr.slice(i, i + chunkSize));
    i += chunkSize;
  }
  return chunks;
}

async function runForever (f, interval, errorInterval, startDelay) {
  log.info(`Running forever with interval = ${interval}, errorInterval = ${errorInterval}, startDelay = ${startDelay}`);
  await sleep(startDelay);
  while (true) {
    try {
      await f();
      await sleep(interval);
    } catch (e) {
      log.error(`Failed with ${e.stack}. Restarting in ${errorInterval} ms.`);
      await sleep(errorInterval);
    }
  }
}

module.exports = {
  hex,
  sleep,
  chunk,
  runForever,
};
