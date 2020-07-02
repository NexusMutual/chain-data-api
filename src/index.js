require('dotenv').config();
const routes = require('./routes');
const ChainDataAggregator = require('./chain-data-aggregator');
const NexusContractLoader = require('./nexus-contract-loader');
const Web3 = require('web3');
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
  const globalStatsSyncInterval = getEnv('GLOBAL_STATS_SYNC_INTERVAL');
  const stakerSnapshotsSyncInterval = getEnv('STAKER_SNAPSHOTS_SYNC_INTERVAL');
  const syncFailureRetryInterval = getEnv('SYNC_FAILURE_INTERVAL');
  const annualizedMinDays = getEnv('ANNUALIZED_MIN_DAYS');
  const chainName = getEnv('CHAIN_NAME', 'mainnet');

  log.info(`Connecting to node at ${providerURL}..`);
  const web3 = new Web3(providerURL);
  await web3.eth.net.isListening();

  const nexusContractLoader = new NexusContractLoader(chainName, versionDataURL, web3.eth.currentProvider);
  await nexusContractLoader.init();

  const chainDataAggregator = new ChainDataAggregator(nexusContractLoader, web3, annualizedMinDays);
  const app = routes(chainDataAggregator);
  await startServer(app, PORT);
  log.info(`Chain-api listening on port ${PORT}`);
  log.info(`Launching regular data sync processes..`);

  const backgroundGlobalAggregateStatsSync = runForever(
    chainDataAggregator.syncGlobalAggregateStats.bind(chainDataAggregator),
    globalStatsSyncInterval,
    syncFailureRetryInterval,
    0,
  );

  const syncDailyDelay = 10000;
  const backgroundDailyStakerSnapshotsSync = runForever(
    chainDataAggregator.syncDailyStakerSnapshots.bind(chainDataAggregator),
    stakerSnapshotsSyncInterval,
    syncFailureRetryInterval,
    syncDailyDelay,
  );

  await Promise.all([backgroundGlobalAggregateStatsSync, backgroundDailyStakerSnapshotsSync]);
}

init()
  .catch(error => {
    console.error('Unhandled app error:', error);
    process.exit(1);
  });
