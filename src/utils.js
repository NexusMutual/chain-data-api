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

async function to (promise) {
  return new Promise(resolve => {
    promise
      .then(result => resolve([result, null]))
      .catch(error => resolve([null, error]));
  });
}

async function runForever (f, interval, errorInterval) {
  log.info(`Running forever with interval = ${interval}, errorInterval = ${errorInterval}`);
  while (true) {
    const [, error] = await to(f());
    if (error) {
      log.error(`Failed with ${error.stack}. Restarting in ${errorInterval} ms.`);
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

async function getLastProcessedBlock (model) {

  const lastProcessedItem = await model.findOne().sort({ blockNumber: -1 });
  return lastProcessedItem ? lastProcessedItem.blockNumber : 0;
}

function addDays (date, days) {
  var date = new Date(date.valueOf());
  date.setDate(date.getDate() + days);
  return date;
}

function datesRange (startDate, endDate) {
  const range = [];

  let currentDate = startDate;
  while (currentDate.getTime() < endDate.getTime()) {
    range.push(currentDate);
    currentDate = addDays(currentDate, 1);
  }
  return range;
}

function flattenEvent (event) {
  return { ...event, ...event.returnValues };
}

module.exports = {
  hex,
  sleep,
  chunk,
  runForever,
  insertManyIgnoreDuplicates,
  getLastProcessedBlock,
  to,
  datesRange,
  addDays,
  flattenEvent,
};
