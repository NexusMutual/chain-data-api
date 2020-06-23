const mongoose = require('mongoose');

const overallAggregatedStatsSchema = new mongoose.Schema({
  totalStaked: String,
  coverPurchased: String,
  totalRewards: String,
  averageReturns: String,
  latestBlockProcessed: Number
})
module.exports = mongoose.model('OverallAggregatedStats', overallAggregatedStatsSchema);
