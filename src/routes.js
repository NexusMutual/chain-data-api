const express = require('express');
const log = require('./log');

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
 * @param {ChainDataAggregator} chainDataAggregator
 * @return {app}
 */
module.exports = (chainDataAggregator) => {

  const app = express();

  app.use((req, res, next) => {
    console.log(`${req.method} ${req.originalUrl}`);
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'x-api-key');
    next();
  });

  app.get('/stats/global', asyncRoute(async (req, res) => {

    const { totalStaked, coverPurchased, totalRewards, averageReturns } = await chainDataAggregator.getGlobalAggregatedStats();
    res.json({
      totalStaked,
      coverPurchased,
      totalRewards,
      averageReturns,
    });
  }));

  app.get('/stats/:member', asyncRoute(async (req, res) => {
    const member = req.params.member;
    log.info(`Fetching stats for member ${member}`);
    if (!isValidEthereumAddress(member)) {
      const errMessage = `Not a valid Ethereum address: ${member}`;
      log.error(errMessage);
      return res.status(400).json({ message: errMessage });
    }

    const { totalRewards, annualizedReturns } = await chainDataAggregator.getMemberAggregatedStats(req.params.member);
    res.json({
      totalRewards,
      annualizedReturns,
    });
  }));

  return app;
};

function isValidEthereumAddress (address) {
  const ETHEREUM_ADDRESS_REGEX = /^0(x|X)[a-fA-F0-9]{40}$/;
  return address && address.length === 42 && address.match(ETHEREUM_ADDRESS_REGEX);
}
