const log = require('./log');

const hex = string => '0x' + Buffer.from(string).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const to = promise => new Promise(resolve => {
  promise
    .then(r => resolve([r, null]))
    .catch(e => resolve([null, e]));
});

function chunk (arr, chunkSize) {
  const chunks = [];
  const n = arr.length;
  let i = 0;

  while (i < n) {
    chunks.push(arr.slice(i, i + chunkSize));
    i += chunkSize;
  }

  return chunks;
}

async function runForever (callback, interval, errorInterval, startDelay) {

  log.info(`Running forever with interval = ${interval}, errorInterval = ${errorInterval}, startDelay = ${startDelay}`);
  await sleep(startDelay);

  while (true) {
    const [, error] = await to(callback());
    await sleep(error ? errorInterval : interval);
  }
}

async function insertManyIgnoreDuplicates (model, records) {

  const [result, error] = await model.insertMany(records, { ordered: false });

  if (error.code !== 11000) {
    throw error;
  }

  return result;
}

function isValidEthereumAddress (address) {
  const ETHEREUM_ADDRESS_REGEX = /^0x[a-f0-9]{40}$/i;
  return address && address.match(ETHEREUM_ADDRESS_REGEX);
}

function getEnv (key, fallback = false) {

  const value = process.env[key] || fallback;

  if (!value) {
    throw new Error(`Missing env var: ${key}`);
  }

  return value;
}

module.exports = {
  chunk,
  getEnv,
  hex,
  insertManyIgnoreDuplicates,
  isValidEthereumAddress,
  runForever,
  sleep,
};
