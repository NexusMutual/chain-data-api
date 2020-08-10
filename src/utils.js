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

async function to(promise) {
  return new Promise(resolve => {
    promise
      .then(result => resolve([result, null]))
      .catch(error => resolve([null, error]));
  });
}

async function runForever (f, interval, errorInterval, startDelay) {
  log.info(`Running forever with interval = ${interval}, errorInterval = ${errorInterval}, startDelay = ${startDelay}`);
  await sleep(startDelay);
  while (true) {
    const [result, error] = await to(f());
    if (error) {
      log.error(`Failed with ${e.stack}. Restarting in ${errorInterval} ms.`);
    }
    const sleepInterval = error ? errorInterval : interval;
    await sleep(sleepInterval);
  }
}

async function insertManyIgnoreDuplicates (model, records) {
  try {
    await model.insertMany(records, { ordered: false });
  } catch (e) {
    // ignore duplicate errors with code 11000
    if (e.code !== 11000) {
      throw e;
    } else {
      log.debug(`Duplicates detected and skipped.`);
    }
  }
}

module.exports = {
  hex,
  sleep,
  chunk,
  runForever,
  insertManyIgnoreDuplicates,
  to
};
