require('dotenv').config();
const routes = require('./routes');
const StakingStats = require('./staking-stats');
const NexusContractLoader = require('./nexus-contract-loader');
const Web3 = require('web3');
const { runForever } = require('./utils');
const log = require('./log');
const mongoose = require('mongoose');

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
  const syncFailureRetryInterval = parseInt(getEnv('SYNC_FAILURE_INTERVAL'));
  const annualizedDaysInterval = parseInt(getEnv('ANNUALIZED_DAYS_INTERVAL'));
  const mongoURL = getEnv('MONGO_URL', 'mainnet');
  const etherscanAPIKey = getEnv('ETHERSCAN_API_KEY');

  log.info('Connecting to database..');
  const opts = { useNewUrlParser: true, useUnifiedTopology: true, useCreateIndex: true };
  await mongoose.connect(mongoURL, opts);

  log.info(`Connecting to node at ${providerURL}..`);
  const web3 = new Web3(providerURL);
  const chainId = await web3.eth.getChainId();
  log.info(`ChainId: ${chainId}`);

  const nexusContractLoader = new NexusContractLoader(chainId, versionDataURL, web3);
  await nexusContractLoader.init();

  const chainDataAggregator = new StakingStats(nexusContractLoader, web3, annualizedDaysInterval, etherscanAPIKey);
  const app = routes(chainDataAggregator);
  await startServer(app, PORT);
  log.info(`Chain-api listening on port ${PORT}`);
  log.info(`Launching regular data sync processes..`);

  const backgroundStakingStatsSync = log.runWithContinuationId(
    'staking-stats-sync',
    () => runForever(
      () => chainDataAggregator.syncStakingStats(),
      globalStatsSyncInterval,
      syncFailureRetryInterval,
    ));

  const backgroundWithdrawnRewardSync = log.runWithContinuationId(
    'withdrawn-rewards-sync',
    () => runForever(
      () => chainDataAggregator.syncWithdrawnRewards(),
      globalStatsSyncInterval,
      syncFailureRetryInterval,
    ));

  await Promise.all([backgroundWithdrawnRewardSync, backgroundStakingStatsSync]);
}

init()
  .catch(error => {
    console.error('Unhandled app error:', error);
    process.exit(1);
  });
