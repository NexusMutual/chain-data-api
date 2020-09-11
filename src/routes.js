const express = require('express');
const log = require('./log');
const { ApiKey } = require('./models');

const asyncRoute = route => (req, res, ...rest) => {
  route(req, res, ...rest).catch(e => {
    log.error(`Route error: ${e.stack}`);
    res.status(500).send({
      error: true,
      message: 'Internal server error',
    });
  });
};

/**
 * @param {StakingStats} stakingStats
 * @return {app}
 */
module.exports = (stakingStats) => {

  const app = express();

  app.use((req, res, next) => {
    log.info(`${req.method} ${req.originalUrl}`);
    next();
  });

  app.use(asyncRoute(async (req, res, next) => {

    const origin = req.get('origin');
    const apiKey = req.headers['x-api-key'];

    const allow = () => {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Headers', 'x-api-key');
      next();
    };

    const deny = () => res.status(403).send({
      error: true,
      message: 'Origin not allowed. Contact us for an API key',
    });

    if (/(\.nexusmutual\.io|localhost:3000)$/.test(origin)) {
      return allow();
    }

    if (!apiKey) { // null, undefined, etc
      return deny();
    }

    const domainKey = await ApiKey.findOne({ origin, apiKey });

    if (domainKey === null) {
      return deny();
    }

    allow();
  }));

  app.get('/v1/staking/global-stats', asyncRoute(async (req, res) => {

    const { totalStaked, coverPurchased, totalRewards, averageReturns, createdAt } = await stakingStats.getGlobalStats();
    res.json({
      totalStaked,
      coverPurchased,
      totalRewards,
      averageReturns,
      createdAt,
    });
  }));

  app.get('/v1/staking/staker-stats/:staker', asyncRoute(async (req, res) => {
    const staker = req.params.staker;
    log.info(`Fetching stats for staker ${staker}`);
    if (!isValidEthereumAddress(staker)) {
      const errMessage = `Not a valid Ethereum address: ${staker}`;
      log.error(errMessage);
      return res.status(400).json({ message: errMessage });
    }

    const { totalRewards, annualizedReturns } = await stakingStats.getStakerStats(staker);
    res.json({
      totalRewards,
      annualizedReturns,
    });
  }));

  app.get('/v1/staking/contract-stats/:contract', asyncRoute(async (req, res) => {
    const contract = req.params.contract;
    log.info(`Fetching stats for contract ${contract}`);
    if (!isValidEthereumAddress(contract)) {
      const errMessage = `Not a valid Ethereum address: ${contract}`;
      log.error(errMessage);
      return res.status(400).json({ message: errMessage });
    }

    const { error, annualizedReturns } = await stakingStats.getContractStats(contract);
    res.json({
      annualizedReturns,
      error,
    });
  }));

  app.get('/v1/staking/contract-stats', asyncRoute(async (req, res) => {
    log.info(`Fetching stats for all contracts.`);

    const allContractStats = await stakingStats.getAllContractStats();
    res.json(allContractStats);
  }));

  return app;
};

function isValidEthereumAddress (address) {
  const ETHEREUM_ADDRESS_REGEX = /^0x[a-f0-9]{40}$/i;
  return address && address.length === 42 && address.match(ETHEREUM_ADDRESS_REGEX);
}
