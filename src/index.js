require('dotenv').config();
const routes = require('./routes');
const StakingStats = require('./staking-stats');
const NexusContractLoader = require('./nexus-contract-loader');
const Web3 = require('web3');
const { runForever } = require('./utils');
const log = require('./log');

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

  const PORT = getEnv('PORT');
  const providerURL = getEnv('PROVIDER_URL');
  const versionDataURL = getEnv('VERSION_DATA_URL');
  const globalStatsSyncInterval = parseInt(getEnv('GLOBAL_STATS_SYNC_INTERVAL'));
  const stakerSnapshotsSyncInterval = parseInt(getEnv('STAKER_SNAPSHOTS_SYNC_INTERVAL'));
  const syncFailureRetryInterval = parseInt(getEnv('SYNC_FAILURE_INTERVAL'));
  const annualizedDaysInterval = parseInt(getEnv('ANNUALIZED_DAYS_INTERVAL'));
  const network = getEnv('NETWORK', 'mainnet');

  log.info(`Connecting to node at ${providerURL}..`);
  const web3 = new Web3(providerURL);
  await web3.eth.net.isListening();

  const nexusContractLoader = new NexusContractLoader(network, versionDataURL, web3.eth.currentProvider);
  await nexusContractLoader.init();

  const chainDataAggregator = new StakingStats(nexusContractLoader, web3, annualizedDaysInterval);
  const app = routes(chainDataAggregator);
  await startServer(app, PORT);
  log.info(`Chain-api listening on port ${PORT}`);
  log.info(`Launching regular data sync processes..`);

  const backgroundStakingStatsSync = runForever(
    () => chainDataAggregator.syncStakingStats(),
    globalStatsSyncInterval,
    syncFailureRetryInterval,
    0,
  );

  const backgroundWithdrawnRewardSync = runForever(
    () => chainDataAggregator.syncWithdrawnRewards(),
    globalStatsSyncInterval,
    syncFailureRetryInterval,
    0,
  );

  const syncDailyDelay = 20000;
  const backgroundStakerSnapshotsSync = runForever(
    () => chainDataAggregator.syncStakerSnapshots(),
    stakerSnapshotsSyncInterval,
    syncFailureRetryInterval,
    syncDailyDelay,
  );

  await Promise.all([backgroundWithdrawnRewardSync, backgroundStakingStatsSync, backgroundStakerSnapshotsSync]);
}

init()
  .catch(error => {
    console.error('Unhandled app error:', error);
    process.exit(1);
  });
