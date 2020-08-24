const express = require('express');
const log = require('./log');
const cors = require('cors');

const asyncRoute = route => (req, res) => {
  route(req, res).catch(e => {
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

  const whitelist = ['https://nexusmutual.io'];
  const corsOptions = {
    origin: (origin, callback) => {
      if (whitelist.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
  };
  app.use(cors(corsOptions));

  app.get('/staking/global-stats', asyncRoute(async (req, res) => {

    const { totalStaked, coverPurchased, totalRewards, averageReturns, createdAt } = await stakingStats.getGlobalStats();
    res.json({
      totalStaked,
      coverPurchased,
      totalRewards,
      averageReturns,
      createdAt,
    });
  }));

  app.get('/staking/staker-stats/:staker', asyncRoute(async (req, res) => {
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

  app.get('/staking/contract-stats/:contract', asyncRoute(async (req, res) => {
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

  return app;
};

function isValidEthereumAddress (address) {
  const ETHEREUM_ADDRESS_REGEX = /^0(x|X)[a-fA-F0-9]{40}$/;
  return address && address.length === 42 && address.match(ETHEREUM_ADDRESS_REGEX);
}
