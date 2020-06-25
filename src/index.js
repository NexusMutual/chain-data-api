require('dotenv').config();
const routes = require('./routes');
const ChainDataAggregator = require('./chain-data-aggregator');
const VersionData = require('./version-data');
const { runForever } = require('./utils');
const log = require('./log');

const {
  PORT,
} = process.env;

async function startServer (app, port) {
  return new Promise(resolve => app.listen(port, resolve));
}

function getEnv (key, fallback = false) {

  const value = process.env[key] || fallback;

  if (!value) {
    throw new Error(`Missing env var: ${key}`);
  }

  return value;
}

async function init () {

  const providerURL = getEnv('PROVIDER_URL');
  const versionDataURL = getEnv('VERSION_DATA_URL');
  const overallStatsSyncInterval = getEnv('OVERALL_STATS_SYNC_INTERVAL');
  const stakerDataSyncInterval = getEnv('STAKER_DATA_SYNC_INTERVAL');
  const syncFailureRetryInterval = getEnv('SYNC_FAILURE_INTERVAL');

  const versionData = new VersionData(null, versionDataURL, providerURL);

  await versionData.init();

  const chainDataAggregator = new ChainDataAggregator(versionData);
  const app = routes(chainDataAggregator);
  await startServer(app, PORT);
  log.info(`Chain-api listening on port ${PORT}`);
  log.info(`Launching regular data sync processes..`);


  runForever(chainDataAggregator.syncOverallAggregateStats, overallStatsSyncInterval, syncFailureRetryInterval, 0);

  const syncDailyDelay = 10000;
  runForever(chainDataAggregator.syncDailyStakerData, stakerDataSyncInterval, syncFailureRetryInterval, syncDailyDelay);
}

init()
  .catch(error => {
    console.error('Unhandled app error:', error);
    process.exit(1);
  });
