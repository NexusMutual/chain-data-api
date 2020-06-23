const express = require('express');

const asyncRoute = route => (req, res) => {
  route(req, res).catch(e => {
    console.error('Route error:', e);
    res.status(500).send({
      error: true,
      message: 'Internal server error',
    });
  });
};


/**
 * @param {QuoteEngine} quoteEngine
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
      averageReturns
    });
  }));

  return app;
};
