const mongoose = require('mongoose');

const globalAggregatedStatsSchema = new mongoose.Schema({
  totalStaked: String,
  coverPurchased: String,
  totalRewards: String,
  averageReturns: String,
  latestBlockProcessed: Number,
});
module.exports = mongoose.model('GlobalAggregatedStats', globalAggregatedStatsSchema);
