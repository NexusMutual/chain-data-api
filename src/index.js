require('dotenv').config();

const express = require('express');
const Web3 = require('web3');

const routes = require('./routes');
const StakingStats = require('./staking-stats');
const NexusContractLoader = require('./nexus-contract-loader');
const { getEnv, runForever } = require('./utils');
const log = require('./log');

async function startServer (app, port) {
  return new Promise(resolve => app.listen(port, resolve));
}

async function init () {

  const PORT = getEnv('PORT');
  const providerURL = getEnv('PROVIDER_URL');
  const versionDataURL = getEnv('VERSION_DATA_URL');
  const globalStatsSyncInterval = parseInt(getEnv('GLOBAL_STATS_SYNC_INTERVAL'), 10);
  const stakerSnapshotsSyncInterval = parseInt(getEnv('STAKER_SNAPSHOTS_SYNC_INTERVAL'), 10);
  const syncFailureRetryInterval = parseInt(getEnv('SYNC_FAILURE_INTERVAL'), 10);
  const annualizedDaysInterval = parseInt(getEnv('ANNUALIZED_DAYS_INTERVAL'), 10);
  const network = getEnv('NETWORK', 'mainnet');

  log.info(`Connecting to node at ${providerURL}..`);
  const web3 = new Web3(providerURL);
  await web3.eth.net.isListening();

  const nexusContractLoader = new NexusContractLoader(network, versionDataURL, web3.eth.currentProvider);
  await nexusContractLoader.init();

  const stakingStatsAggregator = new StakingStats(nexusContractLoader, web3, annualizedDaysInterval);

  const app = express();
  routes(app, stakingStatsAggregator);
  await startServer(app, PORT);

  log.info(`Chain-api listening on port ${PORT}`);
  log.info(`Launching regular data sync processes..`);

  const backgroundGlobalAggregateStatsSync = runForever(
    stakingStatsAggregator.syncGlobalAggregateStats.bind(stakingStatsAggregator),
    globalStatsSyncInterval,
    syncFailureRetryInterval,
    0,
  );

  const syncDailyDelay = 20000;
  const backgroundDailyStakerSnapshotsSync = runForever(
    stakingStatsAggregator.syncDailyStakerSnapshots.bind(stakingStatsAggregator),
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
