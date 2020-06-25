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

  app.get('/stats/overall', asyncRoute(async (req, res) => {

    const { totalStaked, coverPurchased, totalRewards, averageReturns } = await chainDataAggregator.getOverallAggregatedStats();
    res.json({
      totalStaked,
      coverPurchased,
      totalRewards,
      averageReturns,
    });
  }));

  app.get('/stats/:member', asyncRoute(async (req, res) => {
    const days = parseInt(req.query.annualizedDays);
    if (days < 1 || days > 30) {
      const errMessage = `days parameter needs to be between 1 and 30`;
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
